// 出站网关常量的唯一白名单文件：静态守卫只允许这里出现生产 loopback:port 字面量。
export const DEFAULT_ONEBOT_BASE = 'http://127.0.0.1:3000';
export const DEFAULT_ONEBOT_WS = 'ws://127.0.0.1:3001/';
export const DEFAULT_LOCAL_UI_BASE = 'http://127.0.0.1:8801';
export const PRODUCTION_ONEBOT_PORTS = Object.freeze([3000, 3001]);
