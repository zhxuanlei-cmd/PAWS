# PAWS Engine

Engine 是 PAWS 的 TypeScript 执行层。它读取 [Vault](../vault/AGENTS.md) 中的 Markdown 和项目策略，提供格式校验、可重建的 Context Pack、适配入口检查和 OpenCode 运行时策略。

在本目录安装并构建。

```sh
npm ci
npm run build
npm test
```

构建后的 CLI 默认读取同级 `../vault/`。可用 `--vault` 或 `VAULT_DIR` 选择其他 Vault。

```sh
node dist/src/cli.js --help
node dist/src/cli.js doctor
node dist/src/cli.js schema-check
node dist/src/cli.js fixture-test
node dist/src/cli.js context build --project demo
```

Context Pack 是项目文件的派生快照，可重建。实际使用时按项目资料范围选择宿主和模型提供方。OpenCode 的运行时策略由宿主执行。通用安装入口、按宿主安装方式和项目接续教程见 [PAWS README](../README.md)。
