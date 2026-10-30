# ompweb

[![npm version](https://img.shields.io/npm/v/@kahme247/ompweb.svg?logo=npm&color=e05d44)](https://www.npmjs.com/package/@kahme247/ompweb)
[![node version](https://img.shields.io/node/v/@kahme247/ompweb.svg?logo=node.js&color=44cc11)](https://nodejs.org)
[![license](https://img.shields.io/github/license/kahme247/ompweb.svg?color=44cc11)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/@kahme247/ompweb.svg?color=44cc11)](https://www.npmjs.com/package/@kahme247/ompweb)
[![GitHub stars](https://img.shields.io/github/stars/kahme247/ompweb.svg?logo=github)](https://github.com/kahme247/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kahme247/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

社群交流：[加入 OMPWEB Discord](https://discord.gg/evqgGzRfM5)

專為 [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) 程式設計代理打造的簡潔、現代化 Web UI。它能直接讀取本機 omp 對話紀錄，提供瀏覽器工作區讓你與代理交談、瀏覽專案、管理設定與預覽檔案。

![ompweb — 即時對話示範](docs/demo.gif)

<details>
<summary>畫面截圖（淺色／深色模式）</summary>

![ompweb — 淺色主題](docs/screenshot-light.png)

![ompweb — 深色主題](docs/screenshot-dark.png)

</details>

## 系統需求

- 已安裝 [omp](https://github.com/can1357/oh-my-pi) 並設定於系統 `PATH` 中（或透過 `OMP_WEB_OMP_BIN` 指定路徑）
- Node.js `>= 24`

針對佇列中待傳送後續訊息執行的**引導（Steer）**操作，需搭配支援 `promote_queued_message` RPC 指令的 omp 執行階段（omp 18.1.16 尚未支援）。較舊版本會回報錯誤並保留訊息在佇列中作為普通後續訊息；ompweb 不會重複傳送引導訊息。

佇列的**刪除（Delete）**與**編輯（Edit）**額外需要 `remove_queued_message` 支援。刪除操作會先經 OMP 確認後，標籤才會自畫面消失；編輯操作則在成功取消佇列後，才會將文字取回輸入框。若執行階段不支援或該訊息已不再處於等待狀態，佇列將維持原狀並顯示提示。

佇列面板會顯示 omp 自身的佇列狀態（需 omp 18.4.4 或更新版本，支援 `get_state` 中的 `queuedMessages` 與 `queue_update` 事件），因此所有檢視該對話的裝置皆能看到一致的排隊訊息。點選**停止（Stop）**會將仍在佇列中等待的訊息文字退回輸入框，而非任由代理繼續執行；但若模型已經透過即時引導接收了該操作，該次引導仍會繼續執行。較舊的 omp 執行階段不會顯示佇列面板，且停止時無法取回排隊中的訊息。

## 在密碼保護下安裝應用程式（PWA）

若要安裝此 Web 應用程式，請先登入後使用瀏覽器的安裝選單。
網頁中單一的 manifest 連結會附帶認證資訊向 `/api/manifest` 發出請求；該端點使用現有的網頁密碼防護與 private、重新驗證（revalidating）快取機制。
其 192×192 與 512×512 PNG 圖示直接以內嵌方式包含在打包資源中，因為 Android 原生安裝程式在抓取一般圖示網址時不會攜帶驗證 Cookie。安裝後應用程式仍會於 `/` 啟動，作用範圍（scope）為 `/`。

請保持 Cloudflare Access 與應用程式驗證處於啟用狀態；無需為 manifest 設定公開存取例外或 Access 略過規則。此機制並未加入離線支援。本機 Chromium 驗證已涵蓋受 Cookie 保護的中繼資料並封鎖 HTTP 圖示網址的情境（未產生任何安裝性錯誤）。專案維護者亦確認在 Cloudflare Access 保護下，實體手機安裝皆可正常運作。

技能啟動提示需搭配支援 `get_skill_diagnostics`、`set_skill_startup_diagnostics` 與 `skill_diagnostics_update` 的 OMP 執行階段。衝突與多餘重複安裝的項目會在該 OMP 對話啟動時顯示於訊息輸入框上方；開啟空白的新對話頁面不會單純為了診斷而啟動 OMP。點選**詳細資訊**可檢視解析出的預設項目、不同版本、完全相同的副本、實際檔案路徑、來源以及選取原因。點選 **×** 按鈕可在該對話中隱藏該提示，直到診斷報告有所變更為止。點選**關閉**以及前往**設定 → 介面與行為 → 技能啟動提示**會直接變更 OMP 持久化的 `skills.showStartupDiagnostics` 偏好設定，而非瀏覽器獨立設定。即使提示已關閉，在已選取的執行中對話內仍可透過**設定 → 擴充功能與工具 → 技能 → 檢視技能診斷資訊**進行查閱。檢視診斷不會重新接續已停止的對話。若缺乏執行階段支援或沒有執行中的對話，將顯示為無法使用，而非無問題的正常結果。

## 通知功能

在**設定 → 通知**中開啟通知。每個瀏覽器皆各自保留其獨立設定：包含哪些事件需發出通知（任務完成、等待輸入、執行失敗、模型已自動切換），以及當你在另一個分頁使用 omp-web 時的通知方式（應用程式內浮動提示，或一律顯示系統通知）。目前正在檢視中的對話不會顯示通知。點選通知可直接開啟該對話。

- **推播（Push）**即使在未開啟任何 omp-web 分頁時也能送達瀏覽器。此功能需要安全環境（透過反向代理的 HTTPS，或 `localhost`），且 omp-web 伺服器需具備存取瀏覽器廠商推播服務的對外 HTTPS 連線能力。omp-web 會在初次使用時自動產生推播（VAPID）金鑰，並連同裝置清單與通知歷程記錄儲存在其資料目錄中（僅限擁有者存取），因此重新啟動後設定不會遺失。
- 在 **iPhone 與 iPad** 上（iOS 16.4 或更新版本），推播功能僅支援已加入主畫面的應用程式。
- 若在具備安全環境但未支援推播的環境下，只要 omp-web 分頁保持開啟，系統通知依然有效。若在非 localhost 位址透過純 HTTP 連線，瀏覽器會禁止所有系統通知：此時僅會保留在操作 omp-web 時顯示的應用程式內浮動提示。
- 桌面瀏覽器會透過作業系統的通知中心顯示通知。若要接收背景推播，需保持瀏覽器處理程序執行中。

完成通知採用 omp 的 `prompt_result` 與 `session_settled` RPC 訊框（需 omp 18.3.1 或更新版本）。

## 快速開始

**無需安裝直接執行：**

```bash
npx @kahme247/ompweb@latest
```

或
```bash
nix run github:kahme247/ompweb
```

**或是全域安裝：**

```bash
npm install -g @kahme247/ompweb
ompweb
```

在瀏覽器中開啟 [http://127.0.0.1:30177](http://127.0.0.1:30177)。

### 命令列選項

```bash
ompweb --port 8080                         # 自訂連接埠
ompweb --hostname 0.0.0.0                  # 監聽網路介面
ompweb hash-password                       # 輸出供 OMP_WEB_PASSWORD_HASH 使用的雜湊值
ompweb --no-open                           # 不自動開啟瀏覽器
ompweb --install-tray                      # 安裝 Windows 系統匣服務與桌面捷徑
ompweb --uninstall-tray                    # 解除安裝 Windows 系統匣服務與捷徑
ompweb --tray                              # 啟動背景系統匣管理工具
ompweb systemd install                     # 安裝 Linux systemd 使用者服務
ompweb --help                              # 顯示說明
ompweb --version                           # 顯示版本資訊
```

### 密碼保護

omp-web **絕不會將明文密碼傳遞給伺服器**，因為每個 `omp` 對話都會繼承伺服器的環境變數：若代理執行 `env` 指令，將會把密碼列印至對話檔案中並傳送給模型供應商。
使用 `--password` 參數會在啟動時直接阻止 `ompweb` 執行。目前仍暫時支援 `OMP_WEB_PASSWORD` 環境變數：`ompweb` 會在啟動時計算其雜湊值，避免將其留在伺服器環境中，並記錄警告訊息提示應改用 `OMP_WEB_PASSWORD_HASH`。
建議儘速轉換：代理仍有機會自 `ompweb` 啟動處理程序中讀取明文，且每次啟動都會產生新的雜湊值，導致每次重新啟動皆會將所有瀏覽器登出。若同時設定這兩個變數會阻止 `ompweb` 啟動；請移除 `OMP_WEB_PASSWORD`。

請改為產生雜湊值並提供給伺服器：

```bash
ompweb hash-password                       # 詢問兩次密碼，輸入內容自動隱藏
echo "a-long-random-password" | ompweb hash-password   # 或透過管線輸入

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` 會從標準輸入（stdin）讀取密碼——絕不透過命令列引數傳遞——以確保密碼不會出現在 Shell 歷程記錄與 `ps` 行程輸出中。
該雜湊採用帶有全新 16 位元組鹽值（salt）的 scrypt（N = 2^15, r = 8, p = 1），並以自我描述格式 `scrypt$<ln>$<r>$<p>$<salt>$<digest>` 輸出。任何讀取該雜湊的人皆無法直接拿來登入，且無法將其還原為原始密碼。

對話工作階段並非直接以密碼雜湊簽章。首次啟動時會在 `PI_CODING_AGENT_DIR` 指定的代理目錄下（未設定時為 `~/.omp/agent`）建立 `omp-web/web-auth-secret.json`（權限 `0600`），並與雜湊值混淆計算，因此變更密碼依然能將所有人登出，同時單憑儲存的雜湊值絕對無法偽造登入工作階段。

各項服務安裝程式（`ompweb systemd install`、`ompweb-launchd install`、Linux 系統匣以及 Windows 服務）在安裝時仍接受傳入 `OMP_WEB_PASSWORD`，並會在寫入設定檔前先行雜湊處理。設定檔中僅會儲存雜湊值。

在 Windows 上，系統匣與背景服務每次啟動伺服器時，都會直接從使用者或系統環境變數（例如 `setx OMP_WEB_PASSWORD_HASH "scrypt$…"`）讀取 `OMP_WEB_PASSWORD_HASH`，而非從當初啟動服務時的環境變數讀取。變更或移除雜湊值會在下次伺服器重新啟動時生效，無需將 Windows 登出。

### 作為 Windows 服務執行（系統匣）

將 ompweb 安裝為 Windows 背景服務，包含系統匣圖示與開機登入時自動啟動：

```bash
ompweb --install-tray
```

可自**設定 → 系統與更新 → Windows 背景服務**管理，或透過命令列操作：

```bash
ompweb --tray          # 啟動系統匣管理工具
ompweb --uninstall-tray
```

安裝程式會在桌面與開始功能表建立捷徑。服務發生異常時會自動重新啟動，並在系統匣顯示目前連接埠與運作狀態。

### 作為 macOS 服務執行（launchd）

將 ompweb 安裝為 launchd 使用者代理程式（User Agent），於登入時自動啟動並在異常終止時自動重新啟動：

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

管理指令如下：

```bash
npx --yes @kahme247/ompweb@latest ompweb-launchd status      # 顯示服務狀態
npx --yes @kahme247/ompweb@latest ompweb-launchd uninstall   # 停止並移除服務
```

該服務執行 `npx --yes @kahme247/ompweb@latest`；若要鎖定特定版本，可傳入套件規格，例如 `ompweb-launchd install @kahme247/ompweb@0.3.6`。安裝時會讀取所有[環境變數](#環境變數)並寫入 plist 檔案，此外還包含 `OMP_WEB_PKG`（套件規格，等同於位置引數）。作為服務執行時，預設**不會**自動開啟瀏覽器——安裝時帶入 `OMP_WEB_NO_OPEN=0` 可恢復自動開啟行為。

```bash
OMP_WEB_PASSWORD=secret npx --yes @kahme247/ompweb@latest ompweb-launchd install
```

`OMP_WEB_PASSWORD` 會在安裝時立即進行雜湊；plist 內只會儲存雜湊值，絕不包含密碼明文。若使用 `ompweb hash-password` 自行產生了雜湊，亦可直接傳入 `OMP_WEB_PASSWORD_HASH`。

當繫結至非回呼（non-loopback）主機時，請務必設定 `OMP_WEB_PASSWORD_HASH`（反向代理或 VPN 僅提供額外防護），並透過受信任的反向代理或 VPN 使用 HTTPS。切勿將未經驗證的 Web UI 暴露在公開網路中，或在明文 HTTP 連線下傳送密碼與工作階段 Cookie。

記錄檔位於 `~/Library/Logs/ompweb/ompweb.log`，plist 檔案存放於 `~/Library/LaunchAgents/com.kahme247.ompweb.plist`（權限 600；其中儲存的是密碼雜湊，而非密碼明文）。

### 作為 Linux 服務執行（systemd）

將 ompweb 安裝為 systemd **使用者（user）**服務，於登入時自動啟動並在異常終止時自動重新啟動：

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```
安裝程式會自動建立權限為 `600` 的 `~/.omp/agent/web-service.env`；無需手動建立檔案。明確指定 `--package` 參數可確保 `npx` 執行所選套件內的 systemd 執行檔。

若要將服務繫結至所有 IPv4 介面以供區網存取，請在安裝時設定密碼：

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' \
  npx --yes --package=@kahme247/ompweb@latest ompweb-systemd install
```

密碼在寫入 `web-service.env` 之前會先進行雜湊處理。

管理指令如下：

```bash
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd status    # 顯示服務狀態
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd restart   # start / stop / restart
npx --yes --package=@kahme247/ompweb@latest ompweb-systemd uninstall # 停止並移除服務
```

該服務會執行在安裝時解析出的本機 `ompweb` 二進位檔（可透過 `OMP_WEB_SYSTEMD_BIN` 覆寫）。執行階段組態位於 `~/.omp/agent/web-service.env`——透過系統匣（或任何文字編輯器）皆可直接修改連接埠、主機名稱與密碼雜湊，並只需重新啟動服務即可生效，無需重新安裝。
安裝時指定的[環境變數](#環境變數)會直接寫入該檔案。作為服務執行時，預設**不會**自動開啟瀏覽器。服務單元檔位於 `~/.config/systemd/user/ompweb.service`，記錄檔會輸出至 journal：

```bash
journalctl --user -u ompweb -f
```

在無外接顯示器的伺服器（headless server）上，若希望在所有登入階段皆結束後服務仍持續運作，請啟用使用者常駐（lingering）：

```bash
loginctl enable-linger "$USER"
```

### Linux 系統匣（KDE Plasma 及相容環境）

在 Linux 上，`ompweb-tray` 會註冊一個具備快顯功能表的 StatusNotifierItem 系統匣圖示：可開啟 Web UI、複製網址、啟動／停止／重新啟動 systemd 服務、檢視記錄、將 Web UI 暴露至網路、變更連接埠、設定網頁密碼、切換開機自動啟動，以及結束系統匣程式。

```bash
npx --yes @kahme247/ompweb@latest ompweb-tray --install      # 圖示 + 自動啟動 + 啟動系統匣
npx --yes @kahme247/ompweb@latest ompweb-tray --status       # 檢視系統匣與服務狀態
npx --yes @kahme247/ompweb@latest ompweb-tray --uninstall    # 移除自動啟動並停止系統匣
```

**暴露至網路（Expose to Network）**會將服務從 `127.0.0.1` 重新繫結至 `0.0.0.0`，讓 Web UI 能自區網或 VPN（例如 Tailscale）存取。離開回呼介面時必須設定網頁密碼——必要時系統匣會透過 `kdialog`/`zenity` 跳出提示詢問密碼，並儲存其雜湊值。**變更連接埠…**與**設定網頁密碼…**會修改 `~/.omp/agent/web-service.env` 並重新啟動服務。當繫結至非回呼主機時，請務必透過受信任的反向代理或 VPN 使用 HTTPS 進行遠端連線。

系統匣選單中的「隨 Plasma 啟動」可切換位於 `~/.config/autostart/ompweb-tray.desktop` 的桌面自動啟動項目。需要執行中的 StatusNotifierItem 主機支援（KDE Plasma 以及多數 Wayland/X11 桌面環境）。

## 功能特色

- **互動式聊天**：與本機 `omp` 代理進行即時串流交談——完整呈現工具呼叫、思考深度等級、Token 計數、成本花費、上下文容量量表、佇列控制，以及中斷與重試功能。
- **複製訊息內容**：透過每則訊息下方的按鈕，將使用者訊息或已完成的助理回覆複製為渲染後的純文字或原始 Markdown。思考過程、工具輸出與訊息控制項皆會自動排除。使用原始文字檢視器顯示的過長超大訊息，在兩種格式下皆會複製完整原始來源。
- **佇列刪除確認**：在取消 OMP 中排隊的後續訊息或引導訊息之前，提供預覽與確認對話方塊。需具備原生 `remove_queued_message` 支援；已送達的訊息無法撤回。
- **對話管理**：依專案瀏覽歷史對話、建立對話分支（fork）、在對話內部建立分支（branch）、封存／還原對話、匯入對話檔案，並支援透過網址深層連結（deep-link）。
- **草稿復原**：未傳送的輸入文字會保留在對應的對話或新對話工作區內；在瀏覽器儲存空間允許的情況下，於同一個分頁中執行上一頁／下一頁巡覽或重新整理後皆能自動還原（最多保留 50 份草稿）。圖片與檔案附件則僅保留於記憶體中。
- **即時計畫與子代理**：固定於輸入框上方的可摺疊面板，可即時追蹤待辦事項階段與執行中的子代理（狀態、工具、重試次數、Token／成本、巢狀任務），並提供對話紀錄檢視視窗與歷程還原功能。
- **工具組合挑選器**：在輸入框中為新對話選擇工具組合——`none` / `default`（`read,bash,edit,write`）/ `full`（包含子代理在內的所有工具）。設定會持久化儲存在 localStorage 中。
- **檔案總管與預覽**：與聊天介面並列瀏覽工作區檔案；在安全許可清單限制下預覽程式碼、Markdown、Mermaid、圖片、音訊、PDF 與差異比對（diff）。
- **Git Worktree 支援**：直接從側邊欄建立、切換與管理 Git 工作樹（worktree）；對話與檔案根目錄會持續依專案妥善分組。
- **使用量與分析**：位於**設定 → 使用量**的儀表板，提供 Token 數、花費、快取節省分析，並依供應商／模型／日期／專案細分統計，具備 SQLite 資料持久化儲存。
- **Windows 系統匣與服務**：背景服務、系統匣圖示、登入自動啟動，以及桌面／開始功能表捷徑（Windows）。
- **macOS launchd 服務**：LaunchAgent 服務，於登入時啟動、異常終止時自動重新啟動，並在 `~/Library/Logs/ompweb` 下記錄記錄檔。
- **Linux systemd 服務與系統匣**：使用者服務，於登入時啟動、異常終止時自動重新啟動，並附帶具備服務控制功能的 StatusNotifierItem 系統匣圖示（支援 KDE Plasma 與相容桌面環境）。
- **通知功能**：針對任務完成、等待使用者回覆、執行失敗與自動切換模型提供桌面與行動裝置（PWA）通知，在 HTTPS 環境下支援 Web Push 推播。請參閱[通知功能](#通知功能)。
- **Web 設定介面**（10 個分頁）：介面與行為、安全性與核准、AI 模型預設值、API 金鑰與供應商、使用量、代理與智慧功能（顧問、記憶體、壓縮）、代理、擴充功能與工具（MCP、技能、外掛程式）、通知、系統與更新。
- **斜線指令與快速鍵**：快捷提示詞（`/plan`、`/review`、`/fix`、`/test` 等）、`⌘K` / `Ctrl+K` 指令面板，以及模型／推論模式輪替切換。
- **UI 主題與在地化語言**：溫潤紙質風格的淺色／深色主題，加上靈感源自 omp.sh 的午夜黑（`omp`）主題；支援聊天字型大小與介面縮放比例調整，並提供完整的英文、中文（簡體中文／繁體中文）與日文（日本語）翻譯。

## 環境變數

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `PORT` | 伺服器連線埠 | `30177` |
| `OMP_WEB_HOSTNAME` | 伺服器繫結主機位址 | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | 選用，來自 `ompweb hash-password` 的網頁登入密碼 scrypt 雜湊值。繫結至非 loopback 位址時為必填 | _無（停用身分驗證）_ |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | 受信任反向代理於 `X-Omp-Web-Auth` 標頭中傳遞的金鑰 SHA-256 十六進位雜湊摘要，用於略過該請求的密碼驗證；請參閱[在受信任的網路中略過密碼驗證](#在受信任的網路中略過密碼驗證) | _無（已停用）_ |
| `OMP_WEB_NO_OPEN` | 設為 `1` 可防止自動開啟瀏覽器 | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | 設為 `1` 可停用更新檢查與應用程式內更新；變更後需重新啟動 | `0` |
| `OMP_WEB_NAME` | 顯示於瀏覽器分頁與已安裝應用程式的名稱。若設為 `url`、`host` 或 `domain`（不分大小寫），則採用瀏覽器連線的主機名稱（不含連接埠）；localhost 與 IP 位址仍會保持 `omp web`。其他任何值將原樣採用。變更後需重新啟動 | `omp web` |
| `OMP_WEB_OMP_BIN` | 當 `omp` 二進位檔未在 `PATH` 中時指定的路徑 | _自動偵測_ |
| `OMP_WEB_DEV_ORIGIN` | 開發伺服器允許的額外主機名稱（不包含通訊協定或連接埠）；在正式環境中會被忽略 | _無_ |
| `PI_CODING_AGENT_DIR` | 自訂 omp 代理目錄 | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | 相容於 OpenAI 的語音轉文字（STT）端點網址。若保留未設定，則會透過 omp 自身的憑證搭配 `OMP_WEB_STT_MODEL` 進行轉錄 | _無_ |
| `OMP_WEB_STT_KEY` | STT 端點的選用 API 金鑰 | _無_ |
| `OMP_WEB_STT_MODEL` | STT 端點的模型名稱。未設定端點時：使用 omp 登入身分執行的語音轉文字模型，例如 `openai-codex/codex-transcribe`（ChatGPT 訂閱方案；需搭配支援該模型的 omp 版本） | _無（未設定端點時為停用）_ |

**`OMP_WEB_NAME` 與已安裝的應用程式。** 已安裝的應用程式（PWA）名稱通常取自安裝時的頁面名稱。若你之後修改了 `OMP_WEB_NAME`，或者在 `OMP_WEB_NAME` 設為 `url`、`host` 或 `domain` 的情況下從不同位址連入 omp-web，作業系統可能會連帶重新命名該已安裝的應用程式。建議將 `OMP_WEB_NAME` 保留為空，或是設定一個無論透過何種網域名稱或位址連入皆能辨識此 omp-web 伺服器的固定名稱。

## 在受信任的網路中略過密碼驗證

omp-web 本身無法直接得知客戶端的實際位址，因此將此項判斷交由你的反向代理負責。反向代理會在 `X-Omp-Web-Auth` 標頭中傳送一組金鑰，而 omp-web 僅在 `OMP_WEB_TRUSTED_HEADER_SHA256` 中儲存該金鑰的 SHA-256 摘要。
若傳入請求的標頭經雜湊計算後與該摘要相符，即視為已驗證登入。其餘所有連線依然必須透過 `OMP_WEB_PASSWORD_HASH` 中設定的密碼雜湊進行登入；若未設定密碼，則不存在略過驗證的情境，此標頭會被直接忽略。請確保 omp-web 僅繫結至 `127.0.0.1`，以便僅有代理伺服器能夠連線存取。

請依照以下方式產生金鑰及其摘要，避免在命令列中輸入金鑰本體，以防其進入 Shell 歷程記錄。此指令會將隨機金鑰直接寫入僅限 root 與 nginx 讀取的 nginx 設定檔中，且終端機僅會輸出摘要內容：

```bash
secret=$(openssl rand -hex 32)
printf 'map $ompweb_trusted $ompweb_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/ompweb-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

請將 `www-data` 替換為你的 nginx 群組名稱（在部分 Linux 發行版上為 `nginx`）。
將輸出的摘要設定為 `OMP_WEB_TRUSTED_HEADER_SHA256`。此時命令歷程記錄中僅包含執行指令，絕不留存金鑰。在 Windows 上，系統匣與背景服務會自使用者或系統環境變數讀取此值，如同 `OMP_WEB_PASSWORD_HASH`。

務必始終以此方式產生金鑰；切勿重複使用密碼或其他自訂字串。omp-web 儲存的是計算快速且無鹽值的純 SHA-256 摘要，此機制僅對長度充足的隨機金鑰安全：若使用過短或易猜測的字串，任何讀取到摘要的人皆可透過字典攻擊還原原始內容。

搭配 nginx 使用時，請僅向你信任的 IP 範圍傳送該金鑰：

```nginx
# http {} 區塊
geo $ompweb_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/ompweb-auth.conf;  # 上述步驟建立的 map 設定檔

# 轉發至 omp-web 的 location 區塊
proxy_set_header X-Omp-Web-Auth $ompweb_auth;
```

務必如上所示一律設定此標頭：針對其他客戶端所帶入的空字串值，會覆蓋掉客戶端自行傳入的任何 `X-Omp-Web-Auth` 標頭內容。當某個區塊未自行設定任何 `proxy_set_header` 時，nginx 才會自外層區塊繼承設定，因此請將此行與該 location 的其他 `proxy_set_header` 放在一起。

請嚴格僅針對專屬主機名稱提供 omp-web 服務：為其 `server` 區塊明確指定 `server_name`，並加入一個以 `return 444;` 回應所有其他主機名稱的 `default_server` 區塊。否則，受信任瀏覽器所瀏覽的任何惡意網頁皆可能將其網域名稱指向你的 nginx（DNS 重新綁定攻擊，DNS rebinding），進而促使 nginx 在轉發請求時附帶該金鑰。

`geo` 檢查的是連線至 nginx 的直接位址 `$remote_addr`。當客戶端透過另一層代理存取 nginx 時，請使用 [`realip` 模組](https://nginx.org/en/docs/http/ngx_http_realip_module.html) 將其替換為真實的客戶端位址。此模組僅會針對你在 `set_real_ip_from` 中列出的來源位址進行替換：

- **Cloudflare（Proxy DNS 模式）：** 信任 `CF-Connecting-IP`，且僅限來自 Cloudflare 的連線。請列出 <https://www.cloudflare.com/ips-v4/> 與 <https://www.cloudflare.com/ips-v6/> 中的所有 IP 範圍，並保持更新。請僅在確實透過 Cloudflare 代理時使用此設定。

  ```nginx
  set_real_ip_from 173.245.48.0/20;  # ...每個 Cloudflare 範圍各佔一行
  real_ip_header   CF-Connecting-IP;
  ```

  同時拒絕既非來自 Cloudflare 亦非來自受信任範圍的連線。`$realip_remote_addr` 為在 `realip` 替換前的實際連線來源位址：

  ```nginx
  geo $realip_remote_addr $ompweb_peer_allowed {
      default          0;
      173.245.48.0/20  1;  # ...所有 Cloudflare 範圍
      10.0.0.0/16      1;
  }
  # 放在 server 區塊內
  if ($ompweb_peer_allowed = 0) { return 403; }
  ```

- **Cloudflare Tunnel（`cloudflared`）：** 通道會從 `cloudflared` 的位址連線至 nginx（當在同一台主機執行時為 `127.0.0.1`），因此請信任來自該處的 `CF-Connecting-IP`：`set_real_ip_from 127.0.0.1;` 以及 `real_ip_header CF-Connecting-IP;`。然而請注意，任何本機行程皆能自行傳送偽造的 `CF-Connecting-IP` 給 nginx 並宣稱其為受信任位址，且未攜帶該標頭的本機連線仍會保有 `127.0.0.1`，因此在 `$ompweb_trusted` 中列出 `127.0.0.1` 將會信任連線至 nginx 的所有本機行程。
- **任何其他反向代理或負載平衡器：**

  ```nginx
  set_real_ip_from  <代理位址或網段>;
  real_ip_header    X-Forwarded-For;
  real_ip_recursive on;
  ```

  `real_ip_recursive on` 會從最右側開始解析 `X-Forwarded-For`，並略過所有列在 `set_real_ip_from` 中的中繼節點。客戶端自行附加的位址將會被直接忽略。

## 本機開發

```bash
git clone https://github.com/kahme247/ompweb.git
cd ompweb
npm install
npm run dev
```

開發伺服器將執行於 [http://127.0.0.1:30178](http://127.0.0.1:30178)。

開發伺服器允許 loopback 與 RFC1918 私有 IPv4 來源（`10.0.0.0/8`、`172.16.0.0/12` 與 `192.168.0.0/16`）。若搭配穿透通道（tunnel）或反向代理使用自訂主機名稱，無需修改 `next.config.ts` 即可直接指定：

```bash
OMP_WEB_DEV_ORIGIN=dev.example.com npm run dev
```

如需持久化設定，請在你的本機環境變數或服務組態中設定此變數，並重新啟動開發伺服器。此設定不會改變繫結位址或開啟身分驗證。Next.js 的主機名稱比對樣式無法表示 IPv6 CIDR；若需使用私有 IPv6 來源，必須明確指定（例如 `[fd00::1]`）。

### 檢查與測試

```bash
npm run typecheck   # 型別檢查（TypeScript）
npm run lint        # ESLint 程式碼檢查
npm test            # 執行測試套件
```

> **注意**：本機開發期間請勿執行 `npm run build`——它會產生 `.next/` 目錄並可能導致 `npm run dev` 運作異常。

## 授權條款與致謝

- 分支（fork）自 [agegr/pi-web](https://github.com/agegr/pi-web)（MIT 授權）並針對 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 進行調整。
- 採用 [MIT 授權條款](./LICENSE)釋出。
