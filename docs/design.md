# 浏览器指纹虚拟化：设计

## 目标与边界

给竞争情报/风险调研人员一个工具：**同一个浏览器面对不同站点时呈现不同的、内部自洽的指纹；
在同一站点的整个会话（含页面刷新、标签页、SW 重启、浏览器重启）里保持稳定；
页面无法通过检测自身发现指纹被改动过。**

三条硬约束互相拉扯，是整个设计的轴心：

| 约束 | 违反的后果 | 设计回应 |
|---|---|---|
| 跨站必须不同 | 站点间关联，工具失去意义 | 主种子 + eTLD+1 做带密钥 PRF，每站独立档案 |
| 同站必须稳定 | 刷新即变号，比不改更可疑 | 档案是 `f(seed, site)` 的纯函数，无状态、无存储、无竞态 |
| 必须自洽、不可察觉 | 检测脚本只改一处就露馅 | 所有取值从**一个档案推导**；一致性不靠人肉对齐，靠**不变量检查** |

## 一、档案（Profile）：唯一事实来源

档案是一棵从 `seed` 派生的确定性随机树，分两层：

```
seed (32B) = PRF(buildSeed, installSalt)      // 每安装随机，见 spike-results.md
 └─ siteSeed = PRF(seed, "site:" + eTLD+1)     // SipHash-2-4，同步、无依赖
     ├─ hardware:  os, cpu.cores, memoryGB, gpu.vendor/renderer/maxTexture/maxViewport/paramHash
     ├─ screen:    width, height, availWidth, availHeight, dpr, colorDepth, orientation
     ├─ ua:        chromeMajor, platform, uaFull/major, brands, chUaHeader, languages, tz
     ├─ fonts:     字体池采样（含每个字体的度量）
     ├─ canvas:    噪点参数: seed, style, glyphJitter
     ├─ audio:     噪点参数: seed, gainJitter
     └─ media:     deviceCount, deviceIds(派生), codecs
```

**关键点：档案里不存"结果"，只存"参数"。** 渲染结果由参数在本地实时计算，
因此同一档案在任意机器上得到一致结果，且不需要下发巨大的查找表。

### 不变量（Invariants）

这是整套方案最核心的东西。档案在生成后立即跑一遍不变量检查，**不满足就重抽**：

1. `screen.width >= window.innerWidth`（两者都是 CSS 像素；否则视口比屏幕还宽）。
   派生时直接接受真实 `innerWidth/innerHeight` 作为约束（`minViewport`），而不是事后检查。
2. `screen.availWidth <= screen.width`，且 `availHeight <= height`，差值落在任务栏/菜单栏的常见范围
3. `dpr ∈ {1, 1.25, 1.5, 2, 2.5, 3}` 且与 `os` 相符（Windows 常见 1/1.25/1.5/2；macOS 必须是 2 的整数倍）
4. 核数与内存必须是该机型（`DeviceClass`）真实存在的配置，不是任意整数
5. `os=macOS → vendor 为 "Google Inc. (Apple)" 或 (Intel)`；`os=Windows/Linux → vendor 为
   "Google Inc. (NVIDIA/AMD/Intel)"`，且 renderer 字符串与之一致；Apple M 系列 GPU 必然 arm64，
   ANGLE D3D11 renderer 必然 x86
6. `ua.chromeMajor` 必须在 `[当前主版本-2, 当前主版本]` 内，且与 `sec-ch-ua` 头的 brand 表一致
7. `fonts` 必须包含目标 OS 的必装集合（Windows: Segoe UI/Tahoma/Calibri；macOS: SF Pro/Helvetica/Arial）
8. `languages[0]` 与 `timezone` 属于同一地理区域（避免 zh-CN + America/Chicago 这种矛盾组合）
9. 画布扰动幅度 ≤ 1 LSB，且 canvas 与 WebGL 共用同一噪声种子（否则两条读取路径互相矛盾）
10. `WEBGL_debug_renderer_info` 必须在扩展列表里（否则 unmasked renderer 读不到，档案自相矛盾）

**如果抽到的组合过不了不变量，就换下一个候选，而不是打补丁。**
在这套设计里，"改得太狠导致网页出错"和"改得太浅露出破绽"是同一个问题的两端：
前者是违反不变量 1/2/4/5，后者是档案太接近真实机器。

## 二、注入层：无声接管

### 执行时机与顺序
实测（见 spike-results.md）：
- 隔离世界 content script 在 MAIN world 之前、页面首个内联脚本之前运行；
- MAIN world 没有 `chrome.runtime`，必须由隔离世界通过 DOM 属性中转；
- 隔离世界可绕过页面 CSP 做同步 XHR 读扩展静态文件。

因此握手协议：

```
隔离世界 (document_start)
  1. sync XHR 读 chrome-extension://<id>/seed.json  (use_dynamic_url)
  2. 计算本帧 profile（eTLD+1 优先，无 eTLD 退化到 host）
  3. documentElement.setAttribute('data-fp-<nonce>', JSON.stringify(profile))
MAIN world (document_start, 紧跟其后)
  4. 读属性 -> 立即 removeAttribute
  5. 安装全部 patch
页面脚本 (之后)
  6. 看到的是已打好补丁的 API
```

DOM 属性在页面首个脚本之前就被移除了，页面无法通过 MutationObserver 观察到
（observer 只能在页面脚本执行后才注册，而那时属性已不在）。

### 为什么用纯函数而不缓存
每帧、每次刷新、每个标签页都重算一次档案，看起来浪费，
但它消灭了整类 bug：存储竞态、SW 休眠丢失状态、跨进程同步、标签页间不一致。
HMAC 计算开销约 0.1ms，可忽略。

### 伪装层（Native Disguise）
所有被替换的函数统一经过 `mask(fn, name, arity)`：
- 重写 `Function.prototype.toString`，对已知伪函数返回 `function <name>() { [native code] }`；
- 保持 `fn.name`、`fn.length`、property descriptor（writable/configurable/enumerable）与原函数一致；
- 对 `Object.getOwnPropertyDescriptor`、`Reflect.ownKeys`、`for...in` 等元操作层面也保持一致
  （因为补丁是**原地替换**，不新增属性，元操作天然一致）；
- getter/setter 同样用 getter 形式替换，不改成 data property。

## 三、改哪些来源，怎么改

| 来源 | 改法 | 一致性要求 |
|---|---|---|
| `navigator.userAgent` / `userAgentData` | 档案中的 OS+Chrome 大版本 | 与 `sec-ch-ua` 头、`hardwareConcurrency` 所属 OS 一致 |
| `navigator.platform` / `oscpu` | 档案 OS | 同上 |
| `hardwareConcurrency` | 档案 cores | 与 OS 机型档位一致 |
| `deviceMemory` | 档案 memoryGB | 与 cores 档位一致 |
| `screen.*` / `devicePixelRatio` | 档案 screen | 不变量 1/2/3 |
| `Intl` / `timeZone` | 档案 tz + languages | 不变量 8 |
| **Canvas 2D** | `toDataURL`/`toBlob`/`getImageData`：在像素层加**确定性**噪点；`measureText` 加亚像素抖动 | 同一档案同一结果；噪点幅度 < 2 LSB |
| **WebGL** | `getParameter` 返回档案 renderer/vendor/limits；`getSupportedExtensions`、着色器精度、`readPixels` 同步加确定性噪点 | 与 OS/vendor 不变量 5；参数不能超过真实上限 |
| **Audio** | `OfflineAudioContext` 与 `AnalyserNode` 的浮点结果加确定性微小扰动 | 同一档案同一结果，扰动 < 1e-4 |
| **Fonts** | `measureText` 宽度按档案字体池计算；`document.fonts.check` 按档案池作答 | 与 OS 必装字体集合一致 |
| WebRTC / mediaDevices | `enumerateDevices` 按档案 deviceCount 生成稳定 deviceId | 与 audio/video 噪声参数同源 |
| Battery / Connection | 档案中固定 | 与平台档位一致 |
| `screen.orientation` / media queries | 与档案 screen 联动 | 不变量 1 |
| Permissions | 对 profile 范围内的 API 返回稳定状态 | — |
| **检测面加固** | `toString` 伪装；`performance` 与时序不泄漏；`Error.stack` 不暴露注入路径 | 见下节 |

### 一致性引擎
不做"每个 API 各自随机"，而是每个噪声域都用 `derive(siteSeed, domain)` 取子种子。
`webgl.paramHash` 与 `gpu.renderer` 用同一父节点派生，
所以"renderer 说 NVIDIA、但 maxTextureSize 是 Apple 风格"这种矛盾从结构上不可能出现。

## 四、对抗检测脚本：矛盾探针

检测脚本的套路是**制造矛盾**去试探，常见四大类，测试站必须逐条覆盖：

1. **跨 API 矛盾**：UA 说 Windows 但 WebGL vendor 是 Apple；cores=2 但 deviceMemory=32。
2. **物理不可能**：`innerWidth > screen.width`；`dpr=3` 却 `availWidth===width`（任务栏消失）。
3. **原生性检测**：`fn.toString()` 不含 `[native code]`；`hasOwnProperty('toDataURL')` 对原型说 true；
   `Object.getOwnPropertyDescriptor` 的 flags 异常；`Error().stack` 出现 content script 路径。
4. **时序侧信道**：第一次取值 vs 之后取值不同（惰性初始化露馅）；取配置的 XHR 出现在 `performance`；
   同一函数两次调用耗时差异过大。
5. **行为一致性**：`getImageData` 与 `toDataURL` 解码结果不一致；`measureText` 与 DOM 实际渲染宽度不一致；
   `document.fonts.check("12px X")` 说 true 但 `measureText` 给出的宽度等于 fallback 字体。
6. **稳定性**：同一标签页内重复取值、新开标签页、`iframe` 同源/跨源、Worker 内取值，
   结果必须一致（Worker 没有 DOM，需要单独的注入路径）。

## 五、测试站（Fingerprint Lab）

一个自托管的检测站，分三层：

- **collectors/**：按来源分模块采集原始值（canvas/audio/webgl/fonts/screen/hardware/ua/media/behavior）。
- **detectors/**：对采集结果跑规则，输出 `{id, severity, evidence, explains}`。
  规则分 `contradiction`（跨源矛盾）、`unnatural`（原生性/时序）、`instability`（多次取值不一致）。
- **explorer/**：显示完整指纹面板与"本次 vs 上次"对比，供人工研判。

再加一个 **probe harness**：故意在不同上下文（主窗口 / iframe / Worker / 新标签页）
采集同一组值，做六维一致性矩阵。

## 六、测试与报告

- 单元测试：档案派生确定性、不变量、噪声注入不改变结构、native 伪装。
- 端到端：用 CDP 加载扩展（`--enable-unsafe-extension-debugging` + `Extensions.loadUnpacked`），
  跑 lab 全套检测器，断言 0 个 `severity>=high` 的发现。
- 对照：同一浏览器先装扩展跑一遍、再不装跑一遍，量化"改动强度"与"检测通过率"的权衡曲线。

## 七、已知缺口（明确不假装解决）

- TLS/JA3、HTTP/2 指纹、DNS 解析器指纹：扩展层不可达。
- 真实 GPU 的渲染差异：只伪装字符串与参数，不做像素级 GPU 仿真。
- 跨浏览器的版本指纹（Chrome 157 的某个新 API 行为）：档案会被限制在当前主版本窗口内。
- 服务端首跳：冷启动第一个请求的 UA 头依赖 DNR 预装规则，需在扩展启动时完成；
  若用户在扩展加载前就已打开页面，首跳可能是真实 UA（会在报告中标注）。

---

## 八、测试站抓到的真实缺陷（实测记录）

设计写得再自洽，也要靠对抗性测试站检验。下面每一条都是测试站先报出矛盾、随后在扩展里定位并修掉的
真实缺陷。保留这份记录，是因为它们代表这类方案最容易犯、也最容易被检测脚本抓住的错误。

| # | 缺陷 | 检测站如何发现 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `devicePixelRatio` 未被修改 | 屏幕/视口不变量 | `devicePixelRatio` 是 `window` 自有的 accessor，补在 `Window.prototype` 上被自有属性遮蔽，是静默空操作 | 优先补 `window` 自身 |
| 2 | Worker 显示真实指纹 | Worker 与窗口 UA/核数不一致（critical） | 页面 origin 的 blob worker 里 `chrome.runtime` 不存在，shim 取配置失败并静默退出 | shim 改为直接消费包裹器内嵌的档案，不再依赖扩展 API |
| 3 | Worker 时区未变 | Worker 与窗口时区不一致 | `patchFontsAndLocale` 在 worker 里访问 `document` 直接抛错，连带 Intl 补丁未装 | 拆成 `patchFonts` / `patchIntlAndTimeZone`，按 realm 分别安装 |
| 4 | WebGL 两条读取路径不一致（high） | `readPixels` 与「GL canvas 画进 2D canvas 再读」哈希不同 | 路径 A 用 WebGL 种子，路径 B 用 canvas 种子；且 GL 行序自下而上 | 两路共用 canvas 种子与同一投影，并按行翻转归一化 |
| 5 | 子矩形读取与全画布读取不一致 | 同画布读一条带与整图对比 | 投影依赖邻居，而子读取看不到矩形外邻居；且「判定」与「写入」在同一趟进行，先生效的像素改变了后判像素的输入 | 先对整块缓冲区判定、再统一写入；子读取四周多读 `PAD=3` 像素后裁剪 |
| 6 | 纯色区域被噪声污染 | 纯色填充读回多于一种颜色（critical） | 早期方案对每个像素加噪 | 改为只在「有邻域差异」的像素上投影，纯色区保持 bit 精确 |
| 7 | 纹理区整体亮度上升 | 均值统计偏移 | 投影总向上取整，均值抬高约 0.5 | 由哈希第二位决定加减方向，期望偏移为 0 |
| 8 | `WEBGL_debug_renderer_info` 有时缺失 | 部分档案拿不到 unmasked renderer | 扩展列表按 `slice(0, count)` 截断，而该扩展排在部分族的截断点之后 | 列表改为真实 Chrome 顺序，并保证必需项始终存在（新增不变量） |
| 9 | 内嵌 iframe 与窗口画布不同 | 上下文矩阵 | 三个 realm 各自画了不同的内容 | 抽成 `lab/probe-drawing.ts` 单一绘图 |
| 10 | 屏幕小于真实视口 | `innerWidth > screen.width`（critical） | 档案随机挑屏幕，未考虑实际窗口尺寸 | 派生时接受 `minViewport` 约束，仅顶层框架传入 |
| 11 | `toDataURL` 返回 `undefined` | 画布导出为空 | 补丁函数漏写 `return` | 补上返回值（并加入功能回归测试） |
| 12 | 每次重启换指纹 | 重启后同一站点档案变化 | 测试基础设施删掉了传入的 profile 目录，`chrome.storage` 从未落盘 | 只清理自己创建的临时目录 |
| 13 | 并发写盐 | 同上 | 心跳/安装/启动/轮换四处并发调用 `initInstall` | 单飞（single-flight）promise 串行化 |
| 14 | `Intl.DateTimeFormat` 补丁整体失败 | 诊断显示 `fonts-locale` 安装异常 | 对已被冻结的 `prototype` 再次 `defineProperty` | 只定义一次，并让 `replaceConstructor` 容错 |

### 从这些缺陷里提炼的规则

1. **同一个事实只能有一个来源。** 画布、WebGL、字体、UA 全部从档案派生；任何"顺手改一处"都会制造矛盾。
2. **纯函数优于缓存的理由，在测试里变成了硬约束。** 无状态意味着任意 realm、任意时刻算出的档案必然相同，
   这正是缺陷 2、3 的修法所依赖的。
3. **"能读到"和"读到的相同"是两件事。** 缺陷 4、5、9 都不是"没改"，而是"改得不一样"——比没改更难发现，也更危险。
4. **静默失败最危险。** 缺陷 1、2、14 都是异常被吞掉后的空操作。现在每个安装步骤单独 try/catch 且记录失败原因，
   诊断信息放在只有隔离世界能读的 DOM 属性上。
5. **测试站的误报也是缺陷。** 缺陷 5 的一次早期"失败"其实来自测试用 `fillRect` 的栅格化不确定性；
   把测试内容改为 `putImageData` 的确定性像素后才定位到真因。参照组（不装扩展）用来区分"测试站错"和"防御错"。
