# Chrome 157 实测：MV3 指纹扩展的关键机制

在 macOS + Chrome 157.0.8103.79 (headless) 上的实测结论，均用一个最小扩展 + CDP 驱动验证过。
这些结论决定了正式实现只能走哪条路，不能凭直觉假设。

| 问题 | 实测结果 | 对设计的影响 |
|---|---|---|
| `--load-extension` 能否在 headless 加载扩展 | **不能**（Chrome 129+ 移除）。需 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` | 自动化测试必须用 CDP 加载；文档要写清楚手动加载方式 |
| MAIN world content script 里有没有 `chrome.runtime` | **没有**（`chrome.runtime` 为 undefined） | MAIN world 无法自己读配置，必须由隔离世界转交 |
| 隔离世界与 MAIN world 的执行顺序 | 隔离世界先于 MAIN 执行（document_start 下都在页面首个内联脚本之前） | 可以用 DOM 属性中转，且页面脚本读不到该属性 |
| 隔离世界能否绕过页面 CSP 发同步 XHR | **能**（页面 CSP 对扩展隔离世界无效） | 冷启动零延迟取配置可行 |
| 同步 XHR 能否访问 `chrome-extension://<id>/静态文件` | **能**，status 200 | 静态种子文件是最可靠的同步配置通道 |
| 同步 XHR 能否命中 SW 的 `fetch` 拦截 / DNR 改响应头 / DNR redirect | **全部不能**（SW 不拦截扩展自身 scheme；DNR 对扩展资源无效） | 动态种子（按站点即时计算）不能走同步 XHR；只能走静态文件或预取 |
| `use_dynamic_url` 的 web-accessible resource | 能读，且页面无法按 id 猜出静态路径；动态 URL 在同一 profile 内跨标签页稳定，**浏览器重启后变化** | 可以用它藏静态种子文件；但启动时需异步预取一次映射 |
| 同步 XHR 会不会在页面 `performance` 里留 resource entry | **不会** | 取配置本身不泄漏指纹 |
| `webNavigation.onBeforeNavigate` → 异步装 DNR 规则 → 主文档请求 | 首访读不到、二次访问读得到（规则安装与主请求竞速，首访必然输） | **不能用 `onBeforeNavigate` 兜底冷启动**；UA 头伪装必须在启动时对全部 host 预装 |
| DNR `modifyHeaders` 改 `user-agent` / `sec-ch-ua` / `sec-ch-ua-platform` | **能** | 服务端可见的 UA/Client-Hints 可以由每站档案统一改写 |
| 伪造函数伪装 native code | `Function.prototype.toString` 打补丁后，页面侧 `String(fn)`、`fn.toString()`、`fn.name`、`fn.length`、descriptor 均可伪装干净 | 必须做一层统一的 native 伪装，否则比不改更容易被识别 |
| 关键 API 的前置条件 | `MediaDevices.prototype.enumerateDevices` 可写、`Document.prototype.fonts` 有 getter 且 configurable、`measureText` 可写 | 可在 document_start 直接打补丁，无需先探测 |

## 结论：配置通道分层

1. **静态种子文件**（`chrome-extension://<id>/seed.json`，sync XHR，隔离世界）：安装时写入的实例密钥，
   用于派生主种子。同步、零延迟、页面不可见。
2. **每站档案的预计算**：主种子 + 站点 eTLD+1 → HMAC 派生 → 生成完整档案。档案是纯函数，
   任何标签页任何时候算出同一结果，**不需要存储、不需要跨进程通信**。
   这解决了"同站会话一致、跨站不同、重启后仍一致、不落盘"四个要求。
3. **服务端头伪装**：启动时对全量 host 预装 DNR 规则（UA / Client Headers / Accept-Language）。
   规则用请求头 `X-FP-Profile` 或 `requestDomains` 按站点分组；冷启动不依赖竞速。
4. **动态 URL 加固**：静态种子文件用 `use_dynamic_url`，页面无法用扩展 id 猜路径；
   主种子本身（而非派生结果）只在安装时写入一次。

## 不做的事（以及原因）

- 不伪造 TLS/JA3、HTTP/2 指纹、DNS、连接时序：扩展层做不到，伪装会引入更多矛盾。
- 不改 `navigator.userAgentData.brands` 之外的 brand 列表：与 `sec-ch-ua` 头必须一致，改一处就要全改。
- 不做的检测面（会在报告中列为已知缺口）：WebGL 渲染器字符串与真实 GPU 的一致性、
  `chrome://gpu`、`RTCPeerConnection` 本地 IP（属真实网络信息，不属于指纹虚拟化目标）。

## 追加实测：每次安装私有的种子如何同步送达

要求：不同安装实例在同一站点必须得到不同指纹（否则"用了这个工具"本身就成了指纹），
且在 document_start 必须同步获得，页面不能读到。

| 尝试 | 结果 | 说明 |
|---|---|---|
| `chrome.storage.local.get` 同步读 | **不可能**，API 只有 async | — |
| 同步 XHR 读**非** web-accessible 的扩展文件 | **NetworkError** | 必须声明为 WAR，而 WAR 页面也能读 |
| 同步 XHR 读 WAR + `use_dynamic_url` | 隔离世界可读 | 但文件内容是构建期静态的，无法按安装写入 |
| SW `fetch` 拦截自定义域名 | **失败**（扩展自身 scheme 不走 SW） | — |
| DNR 改响应头 / 静态 redirect | 对扩展资源无效 | — |
| **DNR 动态 redirect → `data:` URL**，URL 带构建期 token | **成功**：隔离世界同步读到，页面拿不到（token 不可猜）；**跨浏览器重启保持** | 采用此方案 |

结论：种子 = `HMAC-SHA256(buildSeed, installSalt)`。
- `buildSeed` 写在构建产物的静态文件里；
- `installSalt` 由 service worker 在首次安装时 `crypto.getRandomValues` 生成并存入
  `chrome.storage.local`，同时注册一条动态 DNR 规则：
  `^https://fp.invalid/seed\?t=<buildToken>$ → data:application/json,{"salt":"..."}`；
- 隔离世界在 document_start 同步 XHR 该 URL，拿到 salt，派生档案；
- `buildToken` 每次构建随机，页面无法枚举或猜中；动态规则跨重启持久。

冷启动唯一缺口：若扩展在某次启动后尚未执行过 service worker，动态规则仍已持久化，
因此不受影响；但若用户清除了扩展存储，salt 会重新生成，站点会看到指纹变化（记录为已知行为）。
