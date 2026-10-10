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

キュー内のフォローアップに対する **Steer** 操作には、`promote_queued_message` RPC コマンドをサポートする omp ランタイムが必要です（omp 18.1.16 では未対応）。古いランタイムではエラーを表示し、メッセージはフォローアップとしてキューに残ります。ompweb が重複したステアリングメッセージを送信することはありません。

キューの **Delete** と **Edit** には、さらに `remove_queued_message` が必要です。OMP がキャンセルを確認してから表示を削除し、編集時はキャンセル成功後にテキストを入力欄へ戻します。未対応のランタイムや、すでにキューに存在しないメッセージでは、キューを変更せず通知を表示します。

キューパネルは omp 自身のキュー（`get_state` の `queuedMessages` と `queue_update` イベント、omp 18.4.4 以降）を表示するため、同じセッションを開いているすべての端末に同じキューが表示されます。**Stop** は、まだキューで待機中のメッセージをエージェントに実行させず、そのテキストを入力欄に戻します。ただし、ライブステアリングでモデルがすでに受け取ったステアは実行されます。それより古い omp ではキューパネルは表示されず、Stop でキュー内のメッセージを取り戻すこともできません。

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
ompweb hash-password                      # OMP_WEB_PASSWORD_HASH 用の値を出力
ompweb --no-open                           # ブラウザ自動起動を無効化
```

### パスワード保護

omp-web は**平文パスワードをサーバーに渡しません**。すべての `omp` セッションは
サーバーの環境変数を引き継ぐため、エージェントが `env` を実行するだけで
パスワードがセッションファイルに記録され、モデルプロバイダーにも送信されて
しまうからです。`--password` を指定すると起動を拒否します。`OMP_WEB_PASSWORD`
は当面使えます。`ompweb` が起動時にハッシュ化してサーバーの環境変数から除き、
`OMP_WEB_PASSWORD_HASH` に設定すべきハッシュを警告としてログに出力します。
早めに切り替えてください。エージェントは `ompweb` ランチャープロセスから平文を
読み取れるうえ、起動のたびに新しいハッシュが作られるため、再起動ごとにすべての
ブラウザがサインアウトされます。両方の変数を設定すると起動を拒否するので、
`OMP_WEB_PASSWORD` を削除してください。

代わりにハッシュを生成して渡します。

```bash
ompweb hash-password                       # 二度入力（非表示）
echo "a-long-random-password" | ompweb hash-password   # パイプでも可

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` はパスワードを標準入力から読み取るため（コマンドライン
引数には決して渡しません）、シェル履歴や `ps` に残りません。ハッシュは scrypt
（N = 2^15、r = 8、p = 1）と 16 バイトのソルトで生成し、
`scrypt$<ln>$<r>$<p>$<salt>$<digest>` 形式で出力します。ハッシュを読んでも
サインインには使えず、パスワードへ戻すこともできません。

セッションの署名にパスワードハッシュは使いません。初回起動時に
`~/.omp/agent/omp-web/web-auth-secret.json`（モード `0600`）へランダムな鍵を
生成し、ハッシュと混ぜて署名鍵にします。パスワードを変更すれば既存の
セッションは無効になりますが、保存されたハッシュだけではセッションを
偽造できません。

サービスインストーラー（`ompweb systemd install`、`ompweb-launchd install`、
Linux トレイ、Windows サービス）はインストール時に `OMP_WEB_PASSWORD` を
受け付け、設定ファイルへ書き込む前にハッシュ化します。保存されるのは
ハッシュだけです。

## 主な機能

- **リアルタイムチャット**: ローカルの `omp` エージェントとストリーミング対話。
- **キュー削除の確認**: OMP にキュー登録されたフォローアップやステアメッセージをキャンセルする前に、内容を表示して確認します。ネイティブの `remove_queued_message` 対応が必要です。配信済みのメッセージは取り消せません。
- **セッション管理**: プロジェクトごとに履歴を一覧表示、分岐やフォークにも対応。
- **下書きの復元**: 未送信のテキストを会話または新規セッションのワークスペースごとに保存し、ブラウザストレージが利用可能な場合は、同じタブでの「戻る」「進む」や再読み込み後に復元します（最大 50 件）。画像と添付ファイルはメモリ内にのみ保持されます。
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
| `OMP_WEB_PASSWORD_HASH` | Web ログイン用パスワードの scrypt ハッシュ（`ompweb hash-password` で生成）。非ループバックバインドには必須 | _なし（認証無効）_ |
| `OMP_WEB_NO_OPEN` | `1` でブラウザ自動起動を無効化 | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | `1` で更新チェックとアプリ内更新を無効化（変更後は再起動） | `0` |
| `OMP_WEB_NAME` | ブラウザのタブとインストールしたアプリに表示する名前。`url`・`host`・`domain`（大文字小文字を区別しない）を指定すると、ブラウザが接続したホスト名（ポートなし）を使用します（localhost と IP アドレスは `omp web` のまま）。それ以外の値はそのまま使用します（変更後は再起動） | `omp web` |
| `OMP_WEB_OMP_BIN` | `omp` の絶対パス（PATH 未登録時） | _自動検出_ |
| `PI_CODING_AGENT_DIR` | カスタム omp エージェントディレクトリ | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI 互換の音声認識エンドポイント URL | _なし（無効）_ |
| `OMP_WEB_STT_KEY` | STT エンドポイント用の API キー | _なし_ |
| `OMP_WEB_STT_MODEL` | STT エンドポイント用のモデル名 | _なし_ |

**`OMP_WEB_NAME` とインストールしたアプリ。** インストールしたアプリ（PWA）の名前は、通常インストール元のページの名前になります。あとで `OMP_WEB_NAME` を変更した場合や、`OMP_WEB_NAME` が `url`・`host`・`domain` のときに別のアドレスで omp-web にアクセスした場合、OS がインストール済みアプリの名前も変更することがあります。`OMP_WEB_NAME` は空のままにするか、どのドメイン名やアドレスでアクセスしてもこの omp-web サーバーを識別できる名前を設定することをおすすめします。

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
