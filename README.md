# Web Flow

Chrome 扩展：录制网页操作、试跑回放、保存工作流，支持 AI 自动规划与图形验证码识别。

适用于登录、表单填写、重复点击等通用网页自动化场景。

## 功能

- **录制**：在任意页面手动操作，扩展记录点击、输入、下拉、等待等步骤
- **元素拾取**：编辑步骤时点击「拾取」，在页面上点选元素自动生成 CSS 选择器（类似 UiBot）
- **变量**：步骤可绑定变量（如 username、search）或固定文本，回放时注入
- **回放**：按保存的工作流自动复现操作
- **RPA 步骤**：点击/双击/悬停/滚动/按键/下拉/等待/等待元素/打开网页/提取文本
- **图形验证码**：回放时 OCR 或大模型视觉识别（可配置）
- **AI 自动执行**：大模型分析页面并逐步规划操作（无需预先录制）
- **工作流库**：试跑成功后保存，下次一键运行
- **流程画布**：全屏可视化编辑，节点连线、拖拽排序、步骤编辑（类似 UiBot）
- **打开方式**：全局默认新开标签 / 当前标签，单工作流可覆盖

## 安装（开发者模式）

1. 安装依赖并构建：

```bash
cd extension
npm install
npm run build
```

2. 打开 Chrome → `chrome://extensions`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择 `extension/dist` 目录

## 本地试跑示例

1. 用 Chrome 打开 `extension/sample/login.html`
2. 点击扩展图标，在「录制」页填写变量（如 username / password）
3. 点击「开始录制」，在页面上完成操作
4. 点击「停止录制」，再点「试跑回放」
5. 确认成功后点击「确认成功并保存」
6. 在「工作流」页点击「运行」验证一键执行

## 开发

```bash
cd extension
npm run dev
```

然后在 `chrome://extensions` 中加载 `extension/dist`（开发模式下会自动重建）。

## 安全说明

MVP 将变量（含密码等）明文存储在 `chrome.storage.local`，仅适用于个人本机场景。请勿在公共设备上使用。

## 项目结构

```
extension/
  manifest.json
  src/
    background/          # Service Worker、LLM 调用
    content/             # 录制、回放、页面自动化
    popup/               # 扩展弹窗 UI
    designer/            # 可视化流程画布（全屏标签页）
    shared/              # 步骤表单、元数据等共享模块
    storage/             # 工作流与设置存储
    llm/                 # 大模型客户端与规划
  sample/login.html      # 本地测试页
```
