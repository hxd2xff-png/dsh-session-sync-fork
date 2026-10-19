# 完整依赖归档 / Vendored dependencies

本目录将 `package-lock.json` 锁定的**运行、开发、间接和可选跨平台依赖**的原始 npm 包一起提交到 Git 仓库，并非仅提供依赖名称。

- `npm/*.tgz`：来自 npm 官方注册表的原始依赖包；每包均已验证锁文件中的完整性值。
- `dependencies.json`：每条锁定依赖的版本、来源、完整性值、归档路径、大小和 SHA-256。
- `lockfileCanonicalSha256`：锁文件经 `JSON.stringify(JSON.parse(text))` 规范化后的 SHA-256；不受 Windows/Unix 换行差异影响。
- 各依赖的许可证与上游声明保留在对应原始归档内。复用和再分发时仍须遵守这些许可证。

不复制本机现有 `node_modules`：该目录可能链接到整个 DSH 档案，混入其他插件、绝对路径和设备状态。这里的包来自本插件锁文件的完整依赖集合，而不是其他插件的依赖。

## 常规安装

在仓库根目录执行 `npm ci --ignore-scripts`。这会按锁文件安装依赖，不修改运行中的 DSH 档案。

## 使用仓库中的依赖包离线安装

要求目标机器已安装兼容的 Node.js/npm，并已完整获取本仓库（包含本目录）。以下命令在仓库根目录运行；先将本地依赖归档载入一个独立 npm 缓存，然后**禁止联网**安装。安装生命周期脚本不会执行。

PowerShell：

```powershell
$cache = Join-Path $env:TEMP ('dsh-session-sync-offline-' + [guid]::NewGuid().ToString('N'))
Get-ChildItem .\vendor\npm\*.tgz | ForEach-Object {
  npm.cmd cache add $_.FullName --cache $cache --ignore-scripts --offline
  if ($LASTEXITCODE -ne 0) { throw 'Dependency cache import failed' }
}
npm.cmd ci --cache $cache --offline --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Offline dependency install failed' }
```

POSIX shell：

```sh
cache="$(mktemp -d)"
for package in vendor/npm/*.tgz; do
  npm cache add "$package" --cache "$cache" --ignore-scripts --offline || exit 1
done
npm ci --cache "$cache" --offline --ignore-scripts --no-audit --no-fund
```

锁文件包含所有已锁定的平台可选包；npm 会根据目标系统选择相应的包。Node.js、Git 和 DSH 宿主本身不是本插件的依赖归档，需在目标设备独立安装。

## 更新归档

修改依赖并生成新的锁文件后，在仓库根目录运行：

```sh
node scripts/vendor-locked-dependencies.mjs
```

脚本验证已存在的包，下载缺失包并更新清单；不会执行依赖脚本，也不会读取本机 DSH 配置或凭据。更新锁文件移除依赖后，应一并审阅并移除不再被清单引用的旧归档。

## 验证范围

本次发布保留现有测试资产，不以更改测试断言掩盖问题。进度动画与历史修复的专项非浏览器检查通过；完整测试仍有部分源码文本匹配断言未通过。依赖归档和离线安装成功不代表这些断言已经修复，也不替代页面视觉验收。
