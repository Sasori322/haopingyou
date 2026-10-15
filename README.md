# 好屏友 · Windows 桌面宠物

一只常驻桌面的宠物，外加番茄钟、久坐与喝水提醒、待办便签、系统监控这几件顺手能用的小工具。

- 技术栈：**Electron 44 + Vue 3 + TypeScript**（electron-vite 构建）
- 平台：**仅 Windows**
- 产品名：好屏友（`appId: com.haopingyou.desktop`）
- 内置宠物：**橘子（小橘猫 `cat`）/ 麻薯（小柴犬 `dog`）/ 小可（暹罗猫 `siamese`）**
  —— 小橘猫与暹罗猫已出齐素材，小柴犬暂时回退内置 SVG 占位形象
- 宠物素材：AI 生成的序列帧，可爱平涂插画风格

---

## 快速开始

```bash
npm install
npm run dev            # 开发模式（渲染层 HMR，主进程 / preload 改动自动重启）
npm run typecheck      # 主进程 + 渲染层类型检查
npm run build          # 三进程产物 → out/
npm run pack:dir       # 只解包成目录，快速验证打包
npm run build:win      # NSIS 安装包 + portable（输出到 release/）
```

> **关于 `npm run dev` 的包装器**
> 所有脚本都经由 `tools/electron-vite-run.mjs` 启动。原因：部分宿主环境会预设
> `ELECTRON_RUN_AS_NODE`，而 Electron 只要看到这个变量存在（**哪怕值是空串**）就会退化成纯 Node 运行，
> 此时 `require('electron')` 只返回二进制路径字符串，主进程会在第一行 `app.commandLine` 直接崩溃。
> 包装器在派生 electron-vite 之前删除该变量，子进程继承到干净环境。

---

## 目录结构

```
src/
├─ main/                        主进程
│  ├─ index.ts                  单实例锁 / --autostart 分支 / 启动开关 / 生命周期 / 开发期自检钩子
│  ├─ windows/
│  │  ├─ petWindow.ts           透明宠物窗口（穿透、置顶、不进任务栏、不抢焦点）
│  │  ├─ settingsWindow.ts      设置窗口 + 全窗口广播
│  │  └─ clipboardWindow.ts     剪贴板历史面板（独立窗口，快照式）
│  ├─ pet/
│  │  ├─ petLibrary.ts          扫描 resources/pets 与 userData/pets，读 manifest（扫目录 ⇒ 加宠物零代码）
│  │  ├─ displayManager.ts      多屏 workArea / 贴地 / 左右边界
│  │  ├─ petController.ts       穿透切换、拖拽、走动、工作区夹取、DPI 变化后夹回
│  │  ├─ behaviorScheduler.ts   自发行为随机调度（8–25 秒）
│  │  └─ petApp.ts              状态机 + 气泡 + 素材切换（编排层）
│  ├─ clipboard/
│  │  ├─ clipboardStore.ts      元数据 JSON + 图片 PNG 落盘，100/30 天双重淘汰 + pinned
│  │  ├─ clipboardWatcher.ts    800ms 轮询 Electron 44 异步 Clipboard API（readText/read/ClipboardItem）
│  │  ├─ clipboardHotkey.ts     全局快捷键 format + register-noop 试探 + 调 un/register
│  │  └─ index.ts               IPC 入口、clipboard-img:// 协议、托盘接线、状态广播、动态切目录
│  ├─ services/
│  │  ├─ ipcRegistry.ts         全部 IPC 通道注册 + 入参白名单校验
│  │  ├─ tray.ts                托盘菜单
│  │  ├─ autostart.ts           开机自启（打包后才生效，避开 electron.exe 陷阱）
│  │  ├─ assetProtocol.ts       pet-asset:// 协议（含路径穿越校验）
│  │  ├─ store.ts               极简原子写 JSON 存储
│  │  ├─ settingsService.ts     设置读写（懒初始化，需 app ready 后创建）
│  │  ├─ gazeWatcher.ts         鼠标跟随（60ms 采样全局光标，量化到 1/16 并去重后才发 IPC）
│  │  ├─ foregroundProbe.ts     常驻 PowerShell 辅助进程：前台窗口矩形 + 名单进程命中
│  │  ├─ immersiveWatcher.ts    沉浸检测（名单 / 全屏 / 手动安静），双向 1.5s 防抖
│  │  ├─ reminderScheduler.ts   久坐 / 喝水提醒（存绝对时间戳，不用累加计时器）
│  │  └─ notifier.ts            提醒投递层：系统通知 + 宠物气泡 + 托盘提示，三路并行
│  └─ utils/                    clamp / logger / paths / throttle
├─ preload/index.ts             contextBridge → window.petAPI + window.petAPI.clipboard（白名单）
├─ renderer/
│  ├─ pet.html / settings.html / clipboard.html   三个独立渲染入口
│  └─ src/
│     ├─ pet/                   宠物窗口（轻量，不引 Element Plus）
│     │  ├─ core/usePointerBridge.ts   ★ 两段式点击穿透的渲染层实现
│     │  ├─ core/hitTest.ts            几何命中判定（按动画 bounds，含 petScale 与镜像）
│     │  ├─ core/petAsset.ts           pet-asset:// → Image（crossOrigin=anonymous）
│     │  └─ components/
│     │     ├─ PetSpriteSheet.vue      canvas 序列帧播放器（rAF 累积算帧号）
│     │     ├─ PetSprite.vue           素材缺失时的内置 SVG 占位形象
│     │     └─ Bubble.vue              气泡
│     ├─ settings/              设置窗口（Vue Router hash + Pinia + Element Plus）
│     └─ clipboard/             剪贴板历史面板（不引 Element Plus，纯 CSS + Vue，键盘导航）
├─ shared/                      主 / preload / 渲染三方共享：仅类型与常量
resources/
├─ pets/cat|dog|siamese/manifest.json   宠物清单（`cat` / `siamese` 的 PNG 已就绪即序列帧模式）
└─ icons/                       运行时图标
tools/                          构建期脚本，不进安装包
```

---

## 三个必须讲清楚的核心机制

### 1. 两段式点击穿透（整个项目的技术核心）

Windows 上 Electron **没有逐像素 alpha 命中测试**：`transparent: true` 的窗口，其矩形范围内的透明区域依然会拦截鼠标。
所以：

| 阶段 | 状态 | 说明 |
|---|---|---|
| Stage 1 常态 | `setIgnoreMouseEvents(true, { forward: true })` | 点击完全落到下层；但 mousemove 仍被转发，渲染层因此知道光标在哪 |
| 命中判定 | 渲染层 `hitTest()` | 用 `clientX/clientY` 做几何判定（主判据），命中区比可见像素外扩 8px |
| Stage 2 悬停 | `setIgnoreMouseEvents(false)` | 窗口恢复接收鼠标，此后 mousedown / contextmenu 才真正到达 |

主进程侧强制遵守三条：
1. **去重**：`ignore === 当前值` 时直接 return，不调用 API。
2. **非对称防抖**：进入交互**立即**生效；离开命中区延迟 80ms 再回穿透。
3. **只在边沿切换**：绝不在 `requestAnimationFrame` 或每次 `mousemove` 里切换。

违反任意一条，Windows 上都会出现 DWM 重合成风暴，表现是**整个系统的鼠标都卡**。

另外：先靠 mousemove 把窗口预置为可交互，再等用户点击——不要在 `click` 回调里才切换，那样第一下点击会被吞掉。

**这套握手的唯一恢复路径是一条「被转发的 mousemove」，这是一个单点依赖，必须配兜底。**
窗口一旦被 `hide()` / `showInactive()`（沉浸躲开、托盘隐藏、切换宠物）或系统唤醒打断，
这条事件流就会出现空窗——光标可能**已经**压在宠物身上却因为没动过而永远不产生 mousemove。
此时两侧还会各自停在"我以为我已经可交互"，让恢复消息因为"值没变"被去重掉，
表现是**宠物看得见、却点不动也拖不动**（2026-10-14 实机踩到）。所以：

1. **`setPetVisible()` 是可见性变化的唯一收口**。藏宠物前先强制置回穿透（`forceIgnoreMouse()`），
   显示后由主进程下发一次**指针重同步**（`PET_POINTER_SYNC`，附上主进程算好的光标窗口内坐标），
   渲染层据此**无条件**重算命中。任何直接调 `window.hide()` / `showInactive()` 的写法都是旁路，禁止。
2. **重同步不复用缓存**：渲染层的 `setInteractive()` 对"值没变"直接返回（这正是它被去重掉的原因），
   而重同步路径必须每次都真的算、真的下发。
3. **系统唤醒 / 解锁 / 屏幕变化后也要重同步**（`reclaim` 里一并做）——宠物可能被挪动过，
   而光标同样不会自己产生事件。

> 自查：`HPY_VERIFY_POINTER=1` 一键复现「藏 → 显」，配合 `HPY_DEBUG_POINTER=1` 看穿透态轨迹。

### 2. 拖拽不用 `-webkit-app-region: drag`

`app-region: drag` 会把矩形区域整体变成非客户区，**吞掉该区域内所有指针事件**，与上面的穿透方案直接冲突。
本项目改用：渲染层上报屏幕坐标 + 抓取偏移 → 主进程算位置 → `setPosition`（只传 DIP 整数）。
位移超过 3px 才算拖拽，否则算单击；拖拽期间锁死交互态，避免光标瞬时离开把拖拽打断。
**松手即停**：不做落体插值，宠物就停在拖放位置；走动也只做水平位移、保持当前高度。
高度只由用户决定，主进程任何路径都不会主动改 y。

### 3. 边界必须用 `display.workArea`

`workArea` 已排除任务栏与停靠的 AppBar，用 `bounds` 会让宠物钻到任务栏下面。
屏幕增删、分辨率 / 缩放 / 任务栏位置变化、睡眠唤醒、锁屏解锁，都会触发一次「夹回工作区」——
**只夹取、不改高度**：宠物停在哪就留在哪，主进程只负责保证它不会跑到可视区之外。

---

## 宠物素材规范

每个宠物一个目录，`manifest.json` + 若干 PNG：

```
resources/pets/cat/
├─ manifest.json
├─ stand.png    水平单行 4 帧 → 1600×520（每帧 400×520）  站立正面，idle/click/eat/… 复用
├─ walk.png     水平单行 4 帧                            行走侧面
├─ sleep.png    水平单行 4 帧                            趴卧蜷缩
└─ drag.png     水平单行 4 帧                            悬空挣扎
```

约定：

- `id` 必须与目录名一致；`name` 是**品种名**（"小橘猫"），`nickname` 是**对外称呼**（"橘子"）。
  系统通知、托盘提示、设置页卡片都优先用 `nickname`，缺省回退 `name`。
  ⚠️ `nickname` 只是**默认值**：用户可以在设置页卡片上点 ✎ 改名（存进 `settings.petNames`），优先级高于 manifest
- **sheet 一律水平单行**（解析零歧义、切片最稳）；`frameW = img.width / frames`
- 逻辑画布是 **200×260 DIP**（**非正方形**），帧图为其 **2 倍**，即每帧 400×520。
  画布高度必须**装得下最高的姿态**——悬空挣扎比站立高约 43%，用正方形画布会把它裁掉。
- 锚点固定为**脚底中心**：每帧都要水平居中、底边贴齐画布下边缘
- 同一动画内所有帧按「角色高度中位数」等比缩放，否则猫会一会儿大一会儿小；
  **跨姿态族则必须改用统一的显式缩放系数**（详见下面「跨姿态族的尺寸一致性」）
- 每个动画要写 `bounds`（该动画的内容包络，DIP，相对画布左上角）：渲染层靠它把鼠标命中区贴合宠物，
  不写就只能退回 `manifest.hitbox`，透明区会误吃鼠标
- `interruptible: false` 表示该动作必须播完才能被打断（eat / click / drag）
- `bubbles` 的 key 对应触发原因（click / walk / sleep / eat / hot / focus / rest / drag / drop）

素材缺失时 `hasAssets` 为 `false`，渲染层自动回退为内置 SVG 占位形象，不会白屏也不会崩。

`resources/pets/` 与 `resources/icons/` 通过 `extraResources` 投放到 `process.resourcesPath`，
**不进 asar**（大图进 asar 读取慢，且工具无法直接访问）。

### 素材流水线（零依赖，纯 Node）

脚本共用 `tools/png.mjs`（自写 PNG 编解码 + 泛洪抠底 / 裁剪 / 双线性缩放 / alpha 合成），不需要 sharp，也不需要装任何东西。

```bash
# 0) 图生图锚点：把抠好的透明角色合成回纯洋红底，作为「让模型照着画」的参考图
npm run assets:anchor -- --in cut/cat-stand-front.png --out artwork/cat/_anchor-stand-front.png

# 1) 抠底 + 去水印：AI 生成的原始图 → 干净透明底
npm run assets:cutout -- --in raw/cat --out cut/cat
#    单张：node tools/cutout.mjs --in raw/idle-01.png --out cut/idle-01.png

# 2) 切图（只有在出的是一整张 sheet 时才需要）
#    等分切（手绘/规整 sheet）：
node tools/slice-spritesheet.mjs --sheet raw/idle-magenta.png --frames 6 --out raw/idle-frames --key magenta
#    AI 生成的条带图几乎不可能等间距（实测 4 只猫横向互相重叠 10~15px，四等分切点全落在角色身上），
#    用 --auto 按连通块自动识帧：
node tools/slice-spritesheet.mjs --sheet raw/stand-cut.png --out raw/stand-frames --auto --frames 4

# 2.5) 逐帧尺寸对齐：只有在「逐帧单独出图」时才需要（见下方「一张图多帧 vs 逐帧出图」）
npm run assets:equalize -- --in raw/walk-frames-cut --out raw/walk-frames-even

# 3) 归一化：裁透明边 → 统一缩放 → 重排到固定画布（水平居中、底边贴齐 = 脚底锚点）
#    单个姿态族（自动「填满画布」，只适合「一张图出多帧、同视角」的族）：
node tools/normalize-anchor.mjs --in raw/stand-frames --frames 4 --out .tmp/stand-auto.png --canvas 200 --canvas-h 260 --ratio 2
#    跨姿态族（显式缩放系数 + 非正方形画布 + 导出命中框）——正式用法：
node tools/normalize-anchor.mjs --in raw/stand-frames --frames 4 --out resources/pets/cat/stand.png \
  --canvas 200 --canvas-h 260 --ratio 2 --scale 0.7273 --emit-bounds .workbuddy/tmp/stand.bounds.json

# 4) 校验清单与素材一致性
npm run assets:check

# 5) 目检：把条带拆成单帧放大导出，肉眼确认朝向 / 四肢 / 遮挡
npm run assets:preview -- resources/pets/cat/walk.png .tmp/preview 4 2
```

### 跨姿态族的尺寸一致性（**最容易踩的坑**）

归一化默认是「把内容高度拉到画布留白内」——也就是**填满画布**。单族内部没问题，但**跨姿态必然出错**：
趴卧天然比站立矮一大截，用同一把尺子会把趴着的小猫**放大到跟站着一模一样高**。

正确做法是用**同一个显式缩放系数**换算所有姿态族：

```bash
# 先跑站立族（自动模式），记下打印的 scale
node tools/normalize-anchor.mjs --in raw/stand-frames --frames 4 ... --canvas 200 --ratio 2
#   → 统一缩放 0.7273
# 其余族一律传这个值
node tools/normalize-anchor.mjs --in raw/sleep-frames --frames 4 ... --scale 0.7273
```

前提是各族的源图分辨率和「角色绝对尺度」一致（同一套提示词、同一尺寸出图）。这样姿态之间的
自然高度差就会被保留下来。小猫实测的比例是：**站立 100% / 行走 78% / 趴卧 54% / 悬空 143%**。

**更好的一招：在出图时就解决膨胀。** 悬空族竖向外框到站立的 1.43 倍（就是「拎起来膨大一圈」的元凶）。
暹罗猫直接在 prompt 里写「四腿收拢贴向身体、尾巴盘到身侧、不得竖向拉伸、总高不超过坐姿」，
源图就只有站立的 1.05 倍，成品 184 DIP vs 站立 176 DIP——**比后期缩放补救干净得多**，
因为缩放会连带改变头身比，让它和别的状态看起来不是同一只猫。

### 源图尺度对不上时，怎么反推缩放系数

逐帧单独出图（出图分辨率和取景比例都变了）时，上面那个「同一把尺子」的前提就没了，
必须单独反推一个系数。可以先试**「头部宽度」做桥**：

1. 在一张**已经归一化正确**的旧素材上量出头宽（小猫走路族最终图里是 160px，画布是 2× 位图，即 80 DIP）；
2. 量出新素材的头宽（实测 4 帧中位数 390.5px）；
3. `--scale = 160 / 390.5 = 0.4097`。

```bash
node tools/normalize-anchor.mjs --in raw/walk-frames-even --frames 4 --out resources/pets/cat/walk.png \
  --canvas 200 --canvas-h 260 --ratio 2 --scale 0.4097 --emit-bounds .workbuddy/tmp/walk.bounds.json
```

⚠️ **头宽只在同一视角内可比**：正脸的头天生比侧脸宽得多（实测同一只猫：正脸 214px / 侧脸 160px）。
所以**不要**拿头宽去跨姿态族直接比（站立是正脸、走路是侧脸，比出来会误判成「走路画小了一半」）。
头宽的正确用途是**同视角内的帧间校准**——`assets:equalize` 就是干这个的。

⚠️⚠️ **但别把离线指标当成终审——实测暹罗猫走路族时，五个指标全部给出了错的倍率。**
描边粗细、颈部收窄法量头高、蓝眼像素面积、蓝眼竖直高度、粉色内耳高度，
分别得到 1.75 / 1.74 / 1.52 / 1.42 / 1.62，彼此都不一致；其中前两个还有明确的失效证据
（「对照组」悬空 vs 站立本应 1.0，描边法量出 8 vs 19px；横身姿势下颈部检测会把**身体长度**当成头量）。
根因是**正脸与侧脸本来就不是同一套形状**（眼是横椭圆 vs 圆、耳朵视角不同），任何"同一特征跨视角比大小"的假设都不成立。

**结论：离线指标只配做「同视角内的帧间对齐」；跨姿态的绝对尺度只能看真实渲染。** 做法是用
`HPY_FORCE_STATE` 把宠物钉在指定状态、逐族截图、并排目检（见下面「窗口自检命令」）。
暹罗猫走路族就是拿 0.396 / 0.445 / 0.483 三个候选各截一张对比后定的 **0.445**
（此时走路内容高 178 DIP ≈ 站立 176 DIP）。多花的只是几分钟截图，比反复量像素可靠得多。

要点：

- **必须用洋红幕布 `#FF00FF` 打底，不要指望模型直出透明**。实测 `background: transparent` 参数不生效
  （输出 alpha 全是 255），而改白底更糟：猫的白胸 / 白爪到纯白距离只有约 34，抠图会连角色一起抠掉。
  也别用绿色——猫狗毛色容易含绿 / 灰边。`slice-spritesheet` 的 `--key` 也接受 `r,g,b` 自定义颜色。
- **生成图背景是渐变 + 噪点、右下角还带水印**，直接用 `chromaKey`（固定色 + 全局阈值）抠不干净：
  实测背景到内置 magenta 最远距离 129，默认 tolerance 只有 90。改走 `tools/cutout.mjs`：
  四边中位数估背景 + 边界泛洪的连通性约束 + 剔除「落在右下角且面积远小于主体」的连通块去水印。
  **不要用「相邻差分 + 平滑降噪」**——平滑会把 2-3px 细描边冲淡，洪水穿透进角色内部（实测背景占比飙到 96% 的错误结果）。
- **一张图多帧 vs 逐帧出图，取决于动画要不要「变姿势」**（实测结论，两种都用过）：
  - **身体形变类动画**（呼吸起伏、飘动、抖动）——一张图多帧又快又稳。用图生图（参考图 = 一张干净定妆照、
    `input_fidelity` 拉高），让模型输出「一横排 N 帧的条带」，实测四帧一致性极好，
    出图量从「逐帧 18 次」压到「每族 1 次」。小猫的 `stand` / `sleep` / `drag` 三族都是这么出的。
  - **四肢要换位置的动画**（走路、奔跑、挥手）——**一张图多帧做不到**：模型会把 N 帧画成同一个姿势。
    小猫走路实测失败 **2 次**（换了更强的措辞、把 `input_fidelity` 降到 medium 都不行，
    四帧的腿几乎逐像素一样），如果改成「只画一只猫、只描述一个姿势」则一次就画对了。
    → 结论：**走路这类动画必须逐帧单独出图，再拼条带**（4 帧 = 4 次生成）。
    代价是每张图模型独立取景，**角色大小会不一致**（实测同一套姿势里伸展帧比其它帧小 12%），
    所以中间要多一道 `assets:equalize` 把各帧缩放到一样大。
  - 判断方法：出图后先用 `assets:preview` 把条带拆帧放大，**逐帧对比四肢位置**，别只看缩略图。
  - 参考图要**先抠好再合成回纯洋红底**，否则模型会把参考图角落的水印一起学过去。
- **先跑通 1 个动画再批量生产**，否则返工成本极高。
- **切图会校验整除**：等分切模式下宽度不能被帧数整除时直接报错退出——1px 错位会让整个动画抖动。
- **归一化用「角色高度中位数」算一个统一缩放系数**，而不是逐帧缩放到等高，这样动画里有意的压缩 / 拉伸不会被抹掉；
  同时会打印「帧高度离散度」，超过 25% 说明这组素材本身角色一致性不够，建议重出图。
- **抠图要去两次**：边界泛洪只吃「与画面四边连通」的背景，**被角色围住的背景块会漏掉**
  （典型：四条腿之间的缝隙里透出的幕布，表现为身上残留一小块洋红）。`cutout.mjs` 会在泛洪后
  再补一道全局阈值去除（`--no-enclosed` 可关）。幕布色是饱和洋红，角色调色板里没有这个颜色，所以安全。

图标同样是零依赖生成：

```bash
npm run icons:build   # → build/icon.png、build/icon.ico（16–256 多尺寸）、resources/icons/tray.png
```


---

## 当前进度

> 更细的功能级状态见 [`docs/STATUS.md`](docs/STATUS.md)。

| 里程碑 | 状态 | 内容 |
|---|---|---|
| **M1 技术骨架** | ✅ 已完成 | 透明窗口、两段式穿透、拖拽、多屏贴地、托盘、单实例、自启、设置窗口外壳、占位宠物 |
| **M2 动画与状态机** | 🟡 基本完成 | Canvas 序列帧播放器、`pet-asset://` 素材加载、多宠物切换、按 `bounds` 精确命中 —— 均已完成；**小柴犬素材未产出**（暂回退 SVG 占位），`eat/hot/rest/focus/click` 仍复用站立族 sheet |
| **M2.5 鼠标跟随 + 沉浸躲开** | ✅ | 见 `docs/STATUS.md` 第二部分 |
| **M3 久坐 / 喝水 / 投递层** | ✅ | 加速模式下出 7/7 实机自检。投递层 + 免打扰（丢弃不补发） + 沉浸挂起（补发最近一条） |
| **M3.5 剪贴板历史** | ✅ | 2026-10-15：800ms 轮询 + 100/30 天 + pinned，clipboard-img:// 协议 + Ctrl+Shift+V 面板。**2026-10-15 二轮**：自定义存储目录（绝对路径校验）+ 自定义唤起快捷键（format + register-noop 试探，可禁用）。**2026-10-15 三轮**：录制热键（e.code 翻译物理键 + IPC suspend/resend 旧键避免误触）。`docs/STATUS.md` 第二部分"已完成 · 5"展开 |
| M3.x 番茄钟 / 待办便签 / 系统监控 / 待办截止 | 待做 | 设置项齐全，逻辑未接 |
| M4 打包发布 | 待办 | NSIS / portable 实机验证、图标、SmartScreen 说明 |

设置窗口里番茄钟 / 待办 / 监控的**设置项已可正常保存**，功能逻辑随 M3 补齐。
暹罗猫是新增的第三只宠物——`petLibrary` 是**扫目录**的，因此加宠物**零代码改动**：
放对目录 + 写对 `manifest.json` 即自动出现在切换列表（`npm run assets:check` 显示 9/9 素材就绪）。

---

## M1 验收清单

### 已自动化验证

- [x] `npm run typecheck` 主进程与渲染层均零错误
- [x] `npm run build` 三进程产物齐全（`out/main`、`out/preload`、`out/renderer`）
- [x] 透明窗口四角像素 alpha 全为 0（**无白底、无灰色矩形轮廓**），宠物主体为不透明像素
- [x] 托盘创建成功、自发行为调度启动、宠物素材加载成功

窗口自检命令（不需要打开 DevTools——DevTools 会破坏透明）：

```bash
# Windows CMD
set HPY_CAPTURE_PET=%CD%\.workbuddy\pet-capture.png && npm run dev
# Git Bash
HPY_CAPTURE_PET="$PWD/.workbuddy/pet-capture.png" npm run dev
```

启动后会自动截取宠物窗口（保留 alpha）并退出。其余开发期环境变量：

| 变量 | 作用 |
|---|---|
| `HPY_CAPTURE_PET=<路径>` | 截图宠物窗口（保留 alpha）+ 跑一遍渲染层诊断脚本（DOM 结构 / 命中框 / 画布不透明像素数 / 图片与 fetch 探测），导出 `*.canvas.png` 与 `*.diag.json` 后退出。**透明窗口最典型的失败模式是「截到空帧」，自检先看它** |
| `HPY_FORCE_STATE=<状态名>` | 把宠物**钉在指定状态**（每 200ms 重设一次，否则会被行为调度器抢走）。给姿态族做尺寸 / 观感裁定时用——窗口尺寸固定，逐族截图并排就是用户视角 |
| `HPY_OPEN_SETTINGS=1` | 自动打开设置窗口、把渲染层 console 转发到主进程日志、逐个路由 dump DOM 证据后退出（设置页只能从托盘进，手工路径太长；而「页面空白」和「只是没数据」在日志里长得一样） |
| `HPY_FAST_REMIND=1` | 把提醒阈值从分钟压到秒（久坐 20s / 喝水 25s / 离开判定 45s）。**三者的相对大小关系不能乱改**，否则加速模式自己就不可测了 |
| `HPY_DEBUG_GAZE=1` | 打印鼠标跟随的采样日志（光标位置 / 观察原点 / 距离 / 量化后的方位） |
| `HPY_DEBUG_POINTER=1` | 打印**穿透态的每次切换**（穿透 ↔ 可交互）。只在「进入 / 离开命中区」两个边沿触发，条数与鼠标行为同阶、不刷屏。**排查「宠物点不动 / 拖不动」先看它**：显示之后若一直停在「穿透」，就是两段式握手的回边断了 |
| `HPY_VERIFY_POINTER=1` | 脚本化复现一次「藏 → 显」并打印穿透态轨迹后退出。它会**先把宠物挪到光标底下**（否则光标在窗口外，切回「穿透」与旧代码表现一样、测不出差别），再隐藏 1 秒重显，全程不产生任何真实 `mousemove`。正确表现是「显示（已重同步指针）」后紧跟一次 `穿透态 → 可交互` |

> `HPY_FORCE_STATE` 每次启动前先确认没有旧实例在跑（`Get-Process -Name electron | Stop-Process -Force`），
> 否则单实例锁会让新进程直接退出；另外旧实例收到 second-instance 事件时会把**内存里的旧设置回写磁盘**，
> 期间手改的 `settings.json` 会被覆盖。

已归档的实机截图（`docs/`）：`preview-cat-*.png`（小猫四姿态、走路族、真实窗口）、
`preview-siamese-states.png`（暹罗猫 idle / walk / sleep / drag 四态并排，**尺寸一致性靠它裁定**）、
`preview-siamese-scale.png`（四族同绝对尺度并排）。

### 需要人工确认（我无法代替你操作鼠标）

- [ ] 鼠标在透明区可以正常点中桌面图标；移到宠物身上可以点中并冒气泡
- [ ] 拖拽宠物到副屏、任务栏在左侧 / 顶部 / 自动隐藏时，宠物不越出工作区（不钻到任务栏底下）
- [ ] 拖到半空松手后**原地停住不回弹**，随后它自己走动时也保持同一高度
- [ ] 鼠标快速扫过宠物边缘 50 次，任务管理器中**无全系统鼠标卡顿**
- [ ] 系统缩放 100% ↔ 150% 切换、拖到不同缩放的屏幕，宠物尺寸位置不跳变
- [ ] 打开大型全屏程序再退出，宠物仍在最上层
- [ ] 双击 exe 第二次不会启动第二个实例

---

## 常见问题

**开发态点「开机自启」提示不生效？**
正常。`app.setLoginItemSettings` 只在打包后写入注册表——开发态 `process.execPath` 指向 `electron.exe`，
写进去会导致开机弹出一个空壳。

**系统通知不显示应用名 / 图标？**
`app.setAppUserModelId` 必须与 `electron-builder.yml` 的 `appId` 完全一致，且安装包需要创建开始菜单快捷方式。
开发态通知归属 `electron.exe` 属正常现象——通知**头顶那行小字**是 Windows toast 的「应用名」，
由 AUMID 解析开始菜单快捷方式得到，开发态没有快捷方式就回落成 `electron.exe`，改标题改不掉它；
打包安装后会自动变成 `productName`（好屏友）。
**通知标题不受影响**：投递时统一加上宠物昵称前缀，实际看到的是「小可 · 该喝水啦」（昵称可在设置页宠物卡片上点 ✎ 改）。

**右键菜单跑到离宠物很远的地方？**
`menu.popup({ x, y })` 里的 x / y 是**窗口客户区坐标**（Electron 内部会 `ClientToScreen` 换成屏幕坐标），
而渲染层能拿到的是 `screenX / screenY`（已经是屏幕坐标）。两者混用等于「窗口左上角 + 屏幕坐标」，
菜单会被推到宠物右下方很远的位置。本项目**不传坐标**，交给系统取当前光标位置 —— 右键点在哪，菜单就出现在哪。
改动这块时务必先确认坐标系。

**宠物偶尔不动？**
两个已知诱因都已处理：`disable-features=CalculateNativeWinOcclusion`（Chromium 可能把透明置顶窗口判定为不可见而停止合成）
与 `backgroundThrottling: false`（失焦后 rAF 停摆）。若仍出现，检查是否被其它全屏独占程序抢占。

**没引入 electron-store / better-sqlite3？**
`electron-store` v12 是 pure ESM，而本项目主进程输出 CJS（为了在 `sandbox: true` 下使用 preload），静态 import 会直接报错。
`services/store.ts` 用约 90 行实现了同样的能力：原子写（tmp + rename）、递归默认值补齐、写合并防抖，且零依赖、零原生编译。
待办数据将来若需要全文检索再评估 SQLite。
