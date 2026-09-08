# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

コミュニティ：[OMPWEB Discord に参加](https://discord.gg/evqgGzRfM5)

[oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) コーディングエージェント向けのモダンな Web UI です。ローカルの omp セッションを読み込み、ブラウザから対話、プロジェクト閲覧、設定管理、ファイルプレビューを行えるワークスペースを提供します。

![ompweb — デモ](docs/demo.gif)

<details>
<summary>スクリーンショット（ライト / ダークテーマ）</summary>

![ompweb — ライトテーマ](docs/screenshot-light.png)

![ompweb — ダークテーマ](docs/screenshot-dark.png)

</details>

## 必要条件

- [omp](https://github.com/can1357/oh-my-pi) がインストールされ、`PATH` に含まれていること（または `OMP_WEB_OMP_BIN` で指定）
- Node.js `>= 22.19.0`

## クイックスタート

**インストールせずに直接実行:**

```bash
npx @kahme247/ompweb@latest
```

**またはグローバルにインストール:**

```bash
npm install -g @kahme247/ompweb
ompweb
```

ブラウザで [http://127.0.0.1:30177](http://127.0.0.1:30177) を開きます。

### CLI オプション

```bash
ompweb --port 8080                         # ポート番号指定
ompweb --hostname 0.0.0.0                  # ネットワーク公開
ompweb --password "your-password"          # パスワード認証を有効化
ompweb --no-open                           # ブラウザ自動起動を無効化
```

## 主な機能

- **リアルタイムチャット**: ローカルの `omp` エージェントとストリーミング対話。
- **セッション管理**: プロジェクトごとに履歴を一覧表示、分岐やフォークにも対応。
- **ライブタスク＆サブエージェント**: Todo リストと稼働中サブエージェントの進捗を折りたたみパネルでリアルタイム表示。
- **ファイル閲覧・プレビュー**: チャットと並べてファイルを閲覧、コード・Markdown・画像・音声・PDF をプレビュー。
- **Git Worktree サポート**: サイドバーから直接 Git ワークツリーを切り替え・管理。
- **GUI 設定管理**: 設定ファイルを直接編集することなく、モデル、API キー、MCP サーバー、スキル、プラグイン、OMP 設定を変更可能。
- **スラッシュコマンド・ショートカット**: `/plan`、`/review`、`/fix`、`/test` などの定型プロンプトと `⌘K` / `Ctrl+K` コマンドパレット。
- **テーマと多言語対応**: ペーパー調のライト/ダークテーマ、英語・簡体字中国語・日本語に完全対応。

## 環境変数

| 変数名 | 説明 | デフォルト値 |
| --- | --- | --- |
| `PORT` | サーバーポート | `30177` |
| `OMP_WEB_HOSTNAME` | バインドホスト | `127.0.0.1` |
| `OMP_WEB_PASSWORD` | Web ログイン用パスワード | _なし（認証無効）_ |
| `OMP_WEB_NO_OPEN` | `1` でブラウザ自動起動を無効化 | `0` |
| `OMP_WEB_OMP_BIN` | `omp` の絶対パス（PATH 未登録時） | _自動検出_ |
| `PI_CODING_AGENT_DIR` | カスタム omp エージェントディレクトリ | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 互換の音声認識エンドポイント URL | _なし（無効）_ |
| `OMP_WEB_STT_KEY` | STT エンドポイント用の API キー | _なし_ |
| `OMP_WEB_STT_MODEL` | STT エンドポイント用のモデル名 | _なし_ |

## 開発

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

ローカル開発サーバーは [http://127.0.0.1:30178](http://127.0.0.1:30178) で起動します。

### チェックコマンド

```bash
npm run typecheck   # 型チェック (TypeScript)
npm run lint        # ESLint
npm test            # テスト実行
```

> **注意**: ローカル開発中に `npm run build` を実行しないでください（`.next/` が生成され `npm run dev` に影響を与える恐れがあります）。

## クレジットとライセンス

- [agegr/pi-web](https://github.com/agegr/pi-web) (MIT) をベースに [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 向けに適合・拡張したフォークです。
- [MIT ライセンス](./LICENSE) のもとで公開されています。
