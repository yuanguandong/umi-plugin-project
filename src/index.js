import chalk from 'chalk';
import chokidar from 'chokidar';
import fs from 'fs';
import _ from 'lodash';
import path from 'path';
import utils from '../utils/utils';

const defaultSettings = {}
const {generateUuid} = utils

const { NODE_ENV } = process.env;

const PAGE_PATH = path.resolve(__dirname, '..', 'src/pages');

const subModules = fs
  .readdirSync(path.join(__dirname, '../src/pages'), { withFileTypes: true })
  .filter((item) => !item.name.includes('.') && (item.isSymbolicLink() || item.isDirectory())); // 过滤掉文件

// 计算编译时的模块配置
const getSubModuleConfigs = () => {
  const configs = [];
  // 子模块
  subModules.forEach((_module) => {
    // 子模块配置
    let moduleConfig;
    // 兼容找不到config.js的情况
    try {
      // 路径
      let realPath;
      let umircPath;
      if (_module.isSymbolicLink()) {
        const linkPath = fs.readlinkSync(path.join(__dirname, '../src/pages', _module.name));
        const isAbsolutePath = /^([A-Z]\:\\|\/)/.test(linkPath);
        realPath = isAbsolutePath
          ? path.join(fs.readlinkSync(path.join(__dirname, '../src/pages', _module.name)), 'config.json')
          : path.join(__dirname, '../src/pages', fs.readlinkSync(path.join(__dirname, '../src/pages', _module.name)), 'config.json');
      } else {
        realPath = path.join(__dirname, '../src/pages', _module.name, 'config.json');
        if(fs.existsSync(path.join(__dirname, '../src/pages', _module.name, 'umirc.json'))){
          umircPath = path.join(__dirname, '../src/pages', _module.name, 'umirc.json')
        }
      }
      moduleConfig = require(realPath);
      moduleConfig.dirName = _module.name;
      //如果有umiconfig则需加载umiconfig
      if(umircPath){
        const umiConfig = require(umircPath);
        moduleConfig.umiConfig = umiConfig;
      }
      if (moduleConfig.order >= 0) {
        // config没有order或者order小于0的不加载配置
        configs.push(moduleConfig);
      } else {
        console.log(chalk.yellow(`${_module.name}模块的配置文件缺少order参数或order小于0，故不加载此模块`));
      }
    } catch (e) {}
  });
  configs.sort((a, b) => a.order - b.order);
  return configs;
};

// 格式化路由
const formatRoutePath = (route, pathPrefix) => {
  route.path = route.path[0] === '/' ? route.path : pathPrefix !== '/' ? `${pathPrefix}/${route.path}` : `/${route.path}`;
  route.component &&
    (route.component = route.component.includes(PAGE_PATH) ? route.component : `${PAGE_PATH}/${route.component.replace('./', '')}`);
  route.routes &&
    route.routes.forEach((_route) => {
      formatRoutePath(_route, route.path);
    });
};

const validConfigKey = (key) => {
  return /^[A-Z\d_]+$/.test(key);
};

const subModuleConfigs = getSubModuleConfigs();

// 合并所需函数
function customizer(objValue, srcValue) {
  if (_.isArray(objValue)) {
    return _.unionWith(objValue, srcValue, _.isEqual);
  }
}

// 生成编译时的config[config.json]
const generConfig = () => {
  let _define = {};
  let proxyTarget;
  let defaultDefine = {};
  for (const _key in defaultSettings) {
    if (!validConfigKey(_key)) continue;
    const _setting = defaultSettings[_key];
    defaultDefine[_key] = _setting;
  }
  let moduleDefine = {};
  subModuleConfigs.forEach((moduleConfig, index, arr) => {
    Object.keys(moduleConfig).forEach((key) => {
      if (key === 'proxyTarget') {
        proxyTarget = moduleConfig[key];
      }
      if (!validConfigKey(key)) return;
      if (key === 'LOGIN_CONFIG') {
        moduleConfig[key].backgroundImage &&
          (moduleConfig[key].backgroundImage = `pages/${moduleConfig.dirName}/${moduleConfig[key].backgroundImage.replace('./', '')}`);
      }
      if (key === 'BASE_CONFIG') {
        moduleConfig[key].favicon &&
          (moduleConfig[key].favicon = `pages/${moduleConfig.dirName}/${moduleConfig[key].favicon.replace('./', '')}`);
        moduleConfig[key].logoImage &&
          (moduleConfig[key].logoImage = `pages/${moduleConfig.dirName}/${moduleConfig[key].logoImage.replace('./', '')}`);
        moduleConfig[key].logoImageWhite &&
          (moduleConfig[key].logoImageWhite = `pages/${moduleConfig.dirName}/${moduleConfig[key].logoImageWhite.replace('./', '')}`);
      }
    });
    moduleDefine = _.mergeWith(moduleDefine, moduleConfig, customizer);
  });
  _define = _.merge(_define, defaultDefine, moduleDefine);
  return {
    define: _define,
    proxyTarget,
  };
};



const _config = generConfig();

const modifyRoutesAndConfig = (api) => {
  // 生成最终路由配置
  api.modifyRoutes((routes) => {
    const rootRouter = routes.find((rt) => rt.path === '/'); // BasicLayout 组件
    const rootRouterIndex = routes.findIndex((rt) => rt.path === '/'); // BasicLayout 组件
    function loadRouter(_route) {
      formatRoutePath(_route);
      const _index = rootRouter.routes.findIndex((route) => route.path === _route.path);
      if (~_index) {
        // 覆盖已配置路由
        rootRouter.routes[_index] = _route;
      } else {
        rootRouter.routes.splice(rootRouter.routes.length - 1, 0, _route);
      }
    }
    subModuleConfigs.forEach((moduleConfig) => {
      if (Array.isArray(moduleConfig.routes)) {
        moduleConfig.routes.forEach((_route) => {
          loadRouter(_route);
        });
      } else {
        loadRouter(moduleConfig.routes);
      }
    });
    return routes;
  });

  let prdUmiConfig = {}
  subModuleConfigs.forEach((moduleConfig)=>{
    if(moduleConfig.umiConfig){
      prdUmiConfig = moduleConfig.umiConfig
    }
  })
  //生成最终config
  api.modifyConfig((config) => {
    const finalConfig ={
      ...config,
      ...prdUmiConfig,
      proxy: {
        '/api': {
          target: _config.proxyTarget,
          changeOrigin: true,
          pathRewrite: {
            '^/api': '',
          },
        },
      },
      define: {
        ...config.define,
        ..._config.define,
        ...prdUmiConfig.define,
        PROXY_TARGET: _config.proxyTarget,
      },
    }
    return finalConfig;
  });
};

export default function (api, options) {
  modifyRoutesAndConfig(api);
  if (NODE_ENV === 'production') {
    return;
  }
  //监听config.json重启server
  const watchFilesPath = subModules.reduce(
    (total, module) => total.concat([path.join(__dirname, `../src/pages/${module.name}/config.json`)]),
    [],
  );
  const watcher = chokidar.watch(watchFilesPath);
  watcher.on('change', (filePath) => {
    console.log(chalk.yellow(`${filePath}编译时配置文件发生改变，重启dev环境`));
    api.restartServer()
  });
  process.on('exit', function () {
    watcher.close();
  });
}
