import AppCache from './app-cache';
import ServiceWorker from './service-worker';

import path from 'path';
import deepExtend from 'deep-extend';
import hasMagic from './misc/has-magic';
import minimatch from 'minimatch';
import { Promise } from 'es6-promise';

const hasOwn = {}.hasOwnProperty;
const updateStrategies = ['all', 'hash', 'changed'];
const defaultOptions = {
  caches: 'all',
  scope: '/',
  updateStrategy: 'all',
  externals: [],
  excludes: [],
  relativePaths: false,
  version() {
    return (new Date).toLocaleString();
  },
  rewrites(asset) {
    return asset.replace(/^([\s\S]*?)index.htm(l?)$/, (match, dir) => {
      return dir || '/';
    });
  },

  ServiceWorker: {
    output: 'sw.js',
    entry: path.join(__dirname, '../empty-entry.js')
  },

  AppCache: {
    NETWORK: '*',
    FALLBACK: null,
    directory: 'appcache/',
    caches: ['main', 'additional']
  }
};

export default class OfflinePlugin {
  constructor(options) {
    this.options = deepExtend({}, defaultOptions, options);
    this.hash = null;
    this.assets = null;
    this.scope = this.options.scope;
    this.externals = this.options.externals;
    this.strategy = this.options.updateStrategy;

    this.relativePaths = !this.scope || this.options.relativePaths;
    this.scope = this.relativePaths ? '' : this.scope.replace(/\/$/, '') + '/';

    if (updateStrategies.indexOf(this.strategy) === -1) {
      throw new Error(`Update strategy must be one of [${ updateStrategies }]`);
    }

    if (!Array.isArray(this.externals)) {
      this.externals = [];
    }

    const rewrites = this.options.rewrites || defaultOptions.rewrites;

    if (typeof rewrites === 'function') {
      this.rewrite = (asset) => {
        if (asset.indexOf(this.entryPrefix) === 0) {
          return '';
        }

        return rewrites(asset);
      };
    } else {
      this.rewrite = (asset) => {
        if (asset.indexOf(this.entryPrefix) === 0) {
          return '';
        }

        if (!hasOwn.call(rewrites, asset)) {
          return asset;
        }

        return rewrites[asset];
      };
    }

    this.REST_KEY = ':rest:';
    this.entryPrefix = '__offline_';
    this.tools = {};

    this.addTool(ServiceWorker, 'ServiceWorker');
    this.addTool(AppCache, 'AppCache');

    if (!Object.keys(this.tools).length) {
      throw new Error('You should have at least one cache service to be specified');
    }
  }

  get version() {
    const version = this.options.version;

    return typeof version === 'function' ? version() : version + '';
  }

  apply(compiler) {
    const runtimePath = path.resolve(__dirname, '../runtime.js');

    compiler.plugin('normal-module-factory', (nmf) => {
      nmf.plugin('after-resolve', (result, callback) => {
        if (result.resource !== runtimePath) {
          return callback(null, result);
        }

        const data = {};

        this.useTools((tool, key) => {
          data[key] = tool.getConfig(this);
        });

        result.loaders.push(
          path.join(__dirname, 'misc/runtime-loader.js') +
            '?' + JSON.stringify(data)
        );

        callback(null, result);
      });
    });

    compiler.plugin('make', (compilation, callback) => {
      this.useTools((tool) => {
        return tool.addEntry(this, compilation, compiler);
      }).then(() => {
        callback();
      }, () => {
        throw new Error('Something went wrong');
      });
    });

    compiler.plugin('emit', (compilation, callback) => {
      this.hash = compilation.getStats().toJson().hash;
      this.setAssets(Object.keys(compilation.assets), compilation);

      this.useTools((tool) => {
        return tool.apply(this, compilation, compiler);
      }).then(() => {
        callback();
      }, () => {
        throw new Error('Something went wrong');
      });
    });
  }

  setAssets(assets, compilation) {
    const caches = this.options.caches || defaultOptions.caches;
    const excludes = this.options.excludes;

    if (Array.isArray(excludes) && excludes.length) {
      assets = assets.filter((asset) => {
        for (let glob of excludes) {
          if (minimatch(asset, glob)) {
            return false;
          }
        }

        return true;
      });
    }

    this.assets = assets;

    if (caches === 'all') {
      this.caches = {
        main: this.validatePaths(assets)
      };
    } else {
      let restSection;

      const handledCaches = [
        'main', 'additional', 'optional'
      ].reduce((result, key) => {
        const cache = Array.isArray(caches[key]) ? caches[key] : [];
        let cacheResult = [];

        if (!cache.length) return result;

        cache.some((cacheKey) => {
          if (cacheKey === this.REST_KEY) {
            if (restSection) {
              throw new Error('The :rest: keyword can be used only once');
            }

            restSection = key;
            return;
          }

          const magic = hasMagic(cacheKey);

          if (magic) {
            let matched;

            for (let i = 0, len = assets.length; i < len; i++) {
              if (!magic.match(assets[i])) continue;

              matched = true;
              cacheResult.push(assets[i]);
              assets.splice(i, 1);
              (i--, len--);
            }

            if (!matched) {
              compilation.warnings.push(
                new Error(`OfflinePlugin: Cache pattern [${ cacheKey }] did not matched any assets`)
              );
            }

            return;
          }

          const index = assets.indexOf(cacheKey);

          externalsCheck: if (index === -1) {
            if (this.externals.length && this.externals.indexOf(cacheKey) !== -1) {
              break externalsCheck;
            }

            compilation.warnings.push(
              new Error(`OfflinePlugin: Cache asset [${ cacheKey }] is not found in output assets`)
            );
          } else {
            assets.splice(index, 1);
          }

          cacheResult.push(cacheKey);
        });

        result[key] = this.validatePaths(cacheResult);

        return result;
      }, {});

      if (restSection && assets.length) {
        handledCaches[restSection] =
          handledCaches[restSection].concat(this.validatePaths(assets));
      }

      this.caches = handledCaches;
    }
  }

  validatePaths(assets) {
    return assets
      .map(this.rewrite)
      .filter(asset => !!asset)
      .map(key => {
        if (this.relativePaths) {
          return key.replace(/^\//, '');
        }

        return this.scope + key.replace(/^\//, '');
      });
  };

  stripEmptyAssets(asset) {
    return !!asset;
  }

  useTools(fn) {
    const tools = Object.keys(this.tools).map((tool) => {
      return fn(this.tools[tool], tool);
    });

    return Promise.all(tools);
  }

  addTool(Tool, name) {
    let options = this.options[name];

    if (options === null || options === false) {
      // tool is not needed
      return;
    }

    this.tools[name] = new Tool(options);
  }
}