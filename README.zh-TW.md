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
- Node.js `>= 24`。伺服器運作於 [Bun](https://bun.sh) 上，Bun 會作為 npm 套件的相依套件自動安裝（找不到隨套件安裝的 Bun 時會使用 `PATH` 中的 Bun）

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
**或下載單一二進位檔**（無需 Node 或 npm）：請參閱[單一二進位檔](#單一二進位檔)。


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
ompweb systemd install                     # 安裝 Linux systemd 使用者服務（網頁 + ompweb-host 守護行程）
ompweb launchd install                     # 安裝 macOS launchd 代理程式（網頁 + ompweb-host 守護行程）
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

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` 會從標準輸入（stdin）讀取密碼——絕不透過命令列引數傳遞——以確保密碼不會出現在 Shell 歷程記錄與 `ps` 行程輸出中。
該雜湊採用帶有全新 16 位元組鹽值（salt）的 scrypt（N = 2^15, r = 8, p = 1），並以自我描述格式 `scrypt$<ln>$<r>$<p>$<salt>$<digest>` 輸出。任何讀取該雜湊的人皆無法直接拿來登入，且無法將其還原為原始密碼。

對話工作階段並非直接以密碼雜湊簽章。首次啟動時會在 `PI_CODING_AGENT_DIR` 指定的代理目錄下（未設定時為 `~/.omp/agent`）建立 `omp-web/web-auth-secret.json`（權限 `0600`），並與雜湊值混淆計算，因此變更密碼依然能將所有人登出，同時單憑儲存的雜湊值絕對無法偽造登入工作階段。

各項服務安裝程式（`ompweb systemd install`、`ompweb-launchd install`、Linux 系統匣以及 Windows 服務）在安裝時仍接受傳入 `OMP_WEB_PASSWORD`，並會在寫入設定檔前先行雜湊處理。設定檔中僅會儲存雜湊值。

在 Windows 上，系統匣與背景服務每次啟動伺服器時，都會直接從使用者或系統環境變數（例如 `setx OMP_WEB_PASSWORD_HASH "scrypt$…"`）讀取 `OMP_WEB_PASSWORD_HASH`，而非從當初啟動服務時的環境變數讀取。變更或移除雜湊值會在下次伺服器重新啟動時生效，無需將 Windows 登出。

### 位於反向代理後方

請在 `/api/events/link`（瀏覽器）與 `/api/hosts/link`（主機）上轉發 WebSocket 升級請求；若未轉發升級請求，瀏覽器會在幾秒鐘後自動改用伺服器傳送事件（SSE）。在 nginx 中，這表示需設定 `proxy_http_version 1.1;`、`proxy_set_header Upgrade $http_upgrade;`、`proxy_set_header Connection "upgrade";`，並將 `proxy_read_timeout` 設定為遠高於 30 秒。

### 兩項服務：網頁伺服器與本機守護行程

ompweb 透過一個輕量的守護行程 `ompweb host` 來執行這台機器的 `omp` 對話，該守護行程透過 loopback 與網頁伺服器連結。各服務安裝程式（`ompweb systemd install`、`ompweb launchd install`、`ompweb --install-tray`）都會同時安裝兩項服務：網頁服務與 `ompweb-host`。解除安裝時也會一併移除兩者。

**在前台執行 ompweb**（在終端機中執行 `ompweb`，或使用 `npx @kahme247/ompweb@latest`）不會安裝任何服務，因此不會自動執行守護行程：請在第二個終端機中保持執行 `ompweb host`（使用 npx 時：`npx @kahme247/ompweb@latest host`）。若未執行它，「本機」將保持離線狀態。網頁伺服器在啟動時會寫入守護行程的連線設定，因此請先啟動網頁伺服器。

- **重新啟動或重新部署網頁伺服器不會中斷執行中的作業。** 守護行程會保持 omp 程序持續運作；重新啟動後的網頁伺服器會直接接管它們，不會跳出繼續提示，omp 正在等待的對話方塊或工具呼叫也會重新顯示。
- **重新啟動守護行程則會結束執行作業**（因為它擁有 omp 程序）。若開啟了自動繼續，原本正在執行的對話會自動繼續一次。`ompweb systemd restart` 僅會重新啟動網頁服務；升級版本時，只有在守護行程的連線協定版本超出新版本支援的範圍時，才會重新啟動守護行程。
- **升級後的首次啟動：** 若約 90 秒後仍未連結任何守護行程，ompweb 會顯示橫幅提示您平台的安裝指令。它絕不會自動自行安裝服務。在守護行程執行之前，「本機」會顯示為離線，且無法在上面啟動新的對話。
- **它就像其他任何主機一樣。** 您可以在**設定 → 主機**中重新命名「本機」（清空名稱即可重設）；它無法被撤銷。網頁伺服器僅會在 loopback 繫結位址啟動時，寫入守護行程的連線設定（`~/.omp/agent/omp-web/host.json`，權限 `600`）。
- **開發環境：** `npm run dev` 不會接管守護行程（請參閱[本機開發](#本機開發)）。

### 單一二進位檔

每個[發行版本](https://github.com/kahme247/ompweb/releases/latest)亦提供編譯完成的單一執行檔，隨附其所提供服務的相關檔案：
`ompweb-linux-x64.tar.gz`、`ompweb-linux-arm64.tar.gz`、`ompweb-darwin-x64.tar.gz`、
`ompweb-darwin-arm64.tar.gz` 以及 `ompweb-windows-x64.zip`。無需安裝 Node、npm
或 Bun；僅需安裝 omp。x64 建置版本採用 Bun 的基準執行階段，因此亦可在不具備 AVX2 指令集的 CPU 上運作。每個封存檔皆於 `licenses/` 包含其打包內容的授權條款。`main` 分支上通過 CI 的每次提交亦會發布為以建置時間命名的[預先發行版（prerelease）](https://github.com/kahme247/ompweb/releases)（例如 `2026-11-01T10:30:00Z`），同樣包含上述五種封存檔。

```bash
tar -xzf ompweb-linux-x64.tar.gz -C ~/.local/share   # 解壓縮出 ompweb-linux-x64/
~/.local/share/ompweb-linux-x64/ompweb               # 網頁伺服器：選項與環境變數同上
~/.local/share/ompweb-linux-x64/ompweb host          # 本機守護行程，於第二個終端機執行
```

- **將 `ompweb` 保留在其資料夾內。** 它會從所在目錄提供 `dist/`、`public/` 與其他檔案（在系統 `PATH` 中建立指向它的符號連結可正常運作），若設定了 `OMP_WEB_PACKAGE_DIR` 則從該路徑提供。
- **macOS** 會對下載檔案加上隔離屬性（quarantine）：首次啟動前請先執行一次 `xattr -dr com.apple.quarantine ompweb-darwin-arm64`。
- **macOS 15 或更新版本** 在應用程式存取區域網路前會先詢問權限。若 Mac 上的 `ompweb host` 對區網上的伺服器回報 `ECONNREFUSED`，但 `curl` 卻能正常連線，請前往「系統設定 → 隱私權與安全性 → 區域網路」允許你的終端機（或 `ompweb`）。透過 Tailscale 等 VPN 連線的伺服器，或從 SSH 工作階段啟動的 host 則不受影響。
- **不提供系統匣、服務安裝程式或應用程式內更新。** 若要更新，請停止 `ompweb` 與 `ompweb host`，以新發行版本替換該目錄，然後再次啟動兩者；當有新版本釋出時，**設定 → 系統** 會提供發行頁面連結。你的對話與設定皆儲存於 `~/.omp`，不在該目錄中。
- **作為 systemd 使用者服務**，請自行編寫這兩個單元（請調整路徑；將 omp 所在目錄加入 `PATH`，或設定 `OMP_WEB_OMP_BIN`）：

```ini
# ~/.config/systemd/user/ompweb.service
[Unit]
Description=ompweb web service

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb --no-open
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
# OMP_WEB_PASSWORD_HASH、PORT 與 OMP_WEB_HOSTNAME 放置於此，如同 ompweb-systemd。
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/ompweb-host.service
[Unit]
Description=ompweb host daemon
# 在網頁伺服器寫入連線設定前它會結束：保持重新啟動。
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb ompweb-host
```

  在 macOS 上，編寫兩個 launchd agent（`ProgramArguments` 為 `…/ompweb --no-open` 與 `…/ompweb host`，搭配 `RunAtLoad` 與 `KeepAlive`）可達到相同效果；在 Windows 上，則可建立兩個在登入時執行 `ompweb.exe --no-open` 與 `ompweb.exe host` 的工作排程器工作。


### 作為 Windows 服務執行（系統匣）

將 ompweb 安裝為 Windows 背景服務，包含系統匣圖示與開機登入時自動啟動：

```bash
ompweb --install-tray
```

可自**設定 → 系統 → Windows 背景服務**管理，或透過命令列操作：

```bash
ompweb --tray          # 啟動系統匣管理工具
ompweb --uninstall-tray
```

安裝程式會在桌面與開始功能表建立捷徑。服務發生異常時會自動重新啟動，並在系統匣顯示目前連接埠與運作狀態。安裝時也會將[本機守護行程](#兩項服務網頁伺服器與本機守護行程)註冊為第二個排程工作（`ompweb host`）；系統匣會同時顯示兩者的狀態。

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

記錄檔位於 `~/Library/Logs/ompweb/ompweb.log`（網頁）與 `~/Library/Logs/ompweb/ompweb-host.log`（[本機守護行程](#兩項服務網頁伺服器與本機守護行程)）。plist 檔案存放於 `~/Library/LaunchAgents/com.kahme247.ompweb.plist`（權限 600；其中儲存的是密碼雜湊，而非密碼明文）以及 `~/Library/LaunchAgents/com.kahme247.ompweb-host.plist`。

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
安裝時指定的[環境變數](#環境變數)會直接寫入該檔案。作為服務執行時，預設**不會**自動開啟瀏覽器。服務單元檔位於 `~/.config/systemd/user/ompweb.service` 與 `~/.config/systemd/user/ompweb-host.service`（[本機守護行程](#兩項服務網頁伺服器與本機守護行程)）；記錄檔會輸出至 journal：

```bash
journalctl --user -u ompweb -u ompweb-host -f
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

## 在其他機器上執行對話

單一 ompweb 可以啟動並監看其他機器上的 omp 對話。每台機器保留其各自的 `omp` 安裝、`~/.omp/agent` 目錄、對話與認證資訊；ompweb 僅負責路由。遠端機器需要安裝 `omp` 以及 Node 24（用於 `npx`）或[單一二進位檔](#單一二進位檔)，並且必須能透過 HTTP(S) 連線至 ompweb 伺服器。遠端機器向外連線，因此可以位於 NAT 後方。

1. 在 ompweb 伺服器上，開啟**設定 → 主機 → 新增主機**，輸入名稱，並複製權杖。權杖僅會顯示一次；系統只會儲存其雜湊值。
2. 在遠端機器上儲存連線資訊。權杖是從 stdin 讀取，絕不會作為引數傳遞，因此不會出現在 `ps` 中：

   ```bash
   npx @kahme247/ompweb@latest host login --url https://your-ompweb.example.com
   ```

   出現提示時貼上權杖（或透過管道輸入）。設定會以 `600` 權限儲存至 `~/.omp/agent/omp-web/host.json`。
3. 啟動連線並保持其持續執行：

   ```bash
   npx @kahme247/ompweb@latest host
   ```

   主機會在「設定 → 主機」中顯示為**線上**，側邊欄會為其建立群組，而在新對話畫面中也會出現主機選取器。

**設定 → 主機**也會顯示每台機器的 ompweb 守護行程與 OMP 執行階段版本、可用更新與更新操作（包含**本機**）。檢查與安裝會在所選主機上執行，而非在網頁伺服器上執行。若某個主機更新的連線協定與目前的網頁應用程式不相容，該更新仍會顯示，但會被封鎖並說明原因；請先更新網頁伺服器。無法驗證目標連線協定的更新同樣會被封鎖。OMP 更新則與連線協定無關。在更新守護行程之前，請先關閉其對話行程：更新程式拒絕中斷執行中的對話或子代理。更新 OMP 後，現有行程在重新啟動前仍會維持已載入的舊版本。**設定 → 系統**則保留網頁伺服器自身的應用程式更新與服務設定。主機需要支援這些更新操作的守護行程版本；較舊的版本會顯示不支援訊息，需先手動更新一次。若守護行程與網頁伺服器共用同一個安裝目錄，請先更新伺服器，再使用主機的「僅重新啟動」更新。不支援的服務封裝程式與偵測到的外部重新啟動指令碼會顯示需手動更新的原因。更新前景執行的守護行程前，請先停止外部的自動重新啟動迴圈。

守護行程更新是由主機上獨立的更新程式行程執行。它會停止守護行程、替換為新發行版並再次啟動；若失敗則會還原先前的發行版。若該更新程式在停止守護行程後本身遭到強制終止（例如重新開機或記憶體不足 OOM 終止），將不會有任何程序重新啟動主機，主機便會維持離線。在主機上手動復原方式：在包含安裝目錄的資料夾中，`.ompweb-backup-<id>` 即為先前的發行版。若該目錄存在，請將目前的安裝目錄移開，並將備份重新命名回原本的安裝目錄名稱，然後再次啟動 `ompweb host`（或其服務）。「設定 → 主機」會將該次更新回報為已中斷。

連線必須使用 `https://`。僅在 loopback 位址或指定 `--allow-http` 時（例如在 tailnet 網路中）才接受純 `http://`：

```bash
npx @kahme247/ompweb@latest host login --url http://100.64.0.1:30177
npx @kahme247/ompweb@latest host --allow-http
```

若連線中斷，常駐程式（daemon）會自動重新連線（從 1 秒退避重試，加倍遞增至 60 秒；在同一台機器上的網頁伺服器最多 3 秒）。連線失敗後它會重新讀取儲存的連線資訊，因此即使網頁伺服器在不同連接埠上恢復，也無需重新啟動常駐程式即可自動找到。網路中斷後，遠端機器上的執行作業仍會繼續；聊天介面會顯示離線橫幅，當連線恢復時執行作業會重新連結。筆記型電腦進入睡眠狀態（通常是闔上螢幕）時，會將常駐程式及其 omp 執行作業與其上的其他作業一併暫停：喚醒時會自動恢復，連線也會在當時恢復。接上擴充底座或設定不休眠的裝置則可在闔上螢幕時繼續執行。在設定中撤銷主機會關閉其連線，常駐程式也會停止其 omp 程序。

反向代理必須在 `/api/hosts/link` 上轉發升級請求；請參閱[位於反向代理後方](#位於反向代理後方)。

請先更新伺服器上的 ompweb，再更新其主機：此版本之前的主機在更新前會顯示為**需要升級**。

注意事項：

- **服務輔助程式：** `ompweb systemd install` 與 `ompweb launchd install` 會在網頁伺服器旁同時設定本機自己的守護行程（請參閱[兩項服務](#兩項服務網頁伺服器與本機守護行程)）。在另一台機器上您只需要守護行程，因此請改用[讓主機作為服務持續執行](#讓主機作為服務持續執行)。當伺服器撤銷其權杖，或其連線協定版本超出伺服器支援的範圍時（舊於伺服器支援的最舊版本，或新於伺服器：請在較舊的一方更新 ompweb），守護行程會以結束代碼 `1` 結束；若同一個主機有較新的連線取代它，則以 `0` 結束。SIGTERM 或 SIGINT 會停止守護行程及其 omp 程序。每個主機僅能有一個連線，切勿使用相同權杖執行兩個守護行程。
- **伺服器的代理目錄保存主機清單**（`omp-web/hosts.json`）。若以不同的 `PI_CODING_AGENT_DIR` 啟動 ompweb 伺服器，或遺失該檔案，會導致所有主機權杖失效：每個常駐程式都會收到已遭撤銷的通知，停止其 omp 程序並結束。
- **信任機制：** 已連結的主機會在該機器上為掌控 ompweb 伺服器或權杖的人員執行具備完整工具存取權限的 omp。請妥善保護權杖隱私，並在機器淘汰時將其撤銷。
- **遠端主機尚不支援：** 檔案總管、Git 與工作樹（worktree）面板、目錄瀏覽、封存對話，以及技能、外掛程式、代理與 MCP 設定目前僅在執行 ompweb 的本機上可用。聊天、對話歷史紀錄、通知與開始新對話則在所有主機上皆可正常運作。
- **由代理發起的對話：** 在啟用代理工具時，代理可傳遞 `host` 給 `new_session`（預設為該代理自身所在的主機）。遠端主機每次都會要求確認，除非在「設定 → 主機」中為其開啟了**代理可在此處直接開始對話，無需詢問**。在遠端主機上執行的代理在於本機開始對話或傳送訊息之前，一定會先詢問確認。

### 讓主機作為服務持續執行

以下方式皆以主機模式執行[單一二進位檔](#單一二進位檔)。在 Linux 與 Windows 上，服務可在登出與重新開機後持續維持連線；在 macOS 上，則透過指令碼在終端機中保持執行（原因詳見下方）。請先解壓縮適用於該機器的發行版，接著依照步驟 2 執行一次 `ompweb host login --url …` 以儲存連線資訊（將 `npx @kahme247/ompweb@latest` 替換為二進位檔路徑）。每種設定都會在 `ompweb host` 失敗 10 秒後重新啟動，但結束代碼為 `0` 時不會重新啟動：那代表有使用相同權杖的較新連線取代了它，若重新啟動會導致每 10 秒互相搶奪連線。若伺服器網址為純 `http://`，請在 `host` 後方加上 `--allow-http`；若儲存連線資訊時有設定 `PI_CODING_AGENT_DIR`，請在服務中也一併設定。一台機器僅能連結至一台伺服器：請勿在同一台機器上同時執行 ompweb 網頁伺服器，因為它會為自己的守護行程寫入同一個連線設定檔。若要更新，請先停止服務、替換發行版目錄，然後重新啟動服務。撤銷主機後，請停止並移除其服務，否則它會持續重試。

**Linux（systemd 使用者服務）。** 建立 `~/.config/systemd/user/ompweb-host.service`（請調整發行版路徑，並將 omp 所在目錄加入 `PATH` 或設定 `OMP_WEB_OMP_BIN`）：

```ini
[Unit]
Description=ompweb host
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
# Exit 0: a newer link for this host replaced it. Restarting would take the link back.
RestartPreventExitStatus=0
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb-host
loginctl enable-linger "$USER"            # 登出後仍保持執行
journalctl --user -u ompweb-host -f       # 檢視記錄
```

**macOS（從終端機執行）。** 任何 launchd 工作都無法執行可供 omp 對話完整使用的主機：LaunchDaemon 沒有登入鑰匙圈（login keychain）或 SSH agent（對話需要它們來存取 SSH 金鑰與簽署提交），而 LaunchAgent 則無法連線至區網（LAN）位址。從終端機啟動的程序會繼承終端機的鑰匙圈與 SSH agent，因此請在終端機的 tmux 中執行主機，讓它在視窗關閉後仍持續運作。

不過，tmux 不會保留終端機的「區域網路（Local Network）」權限：tmux 伺服器會與終端機應用程式分離，接著 macOS 的區域網路隱私保護便會封鎖採用臨時簽章（ad-hoc signed）的 `ompweb` 二進位檔存取區網位址（`connect` 會因「No route to host」而失敗，守護行程會回報為 `ECONNREFUSED`；Apple 內建工具如 `curl` 不受封鎖，因此 `curl` 測試會通過）。請將主機連結至不會解析為區網位址的網址，例如伺服器的公開網址，或其 VPN／tailnet 名稱（由您的反向代理搭配自有憑證提供的 Tailscale MagicDNS 名稱）。將以下內容儲存為 `~/.local/bin/ompweb-host-run`（請調整 `DIR`）並以 `chmod +x` 設為可執行：

```sh
#!/bin/sh
# Keeps `ompweb host` running in this terminal, which lends it its keychain and SSH agent.
# Restarts it 10 s after a crash; stops when the token is revoked or the link protocol is
# unsupported (exit 1), or on exit 0: a newer link replaced it, or it was stopped (Ctrl-C).
DIR=${OMPWEB_DIR:-$HOME/.local/share/ompweb-darwin-arm64}
# A tmux started over SSH sees the login keychain locked: unlock it while a terminal can ask.
security show-keychain-info login.keychain-db 2>/dev/null || security unlock-keychain login.keychain-db || exit 1
while :; do
	(cd "$DIR" && exec ./ompweb host)
	rc=$?
	case $rc in 0 | 1) exit "$rc" ;; esac
	echo "ompweb host exited $rc; restarting in 10 s" >&2
	sleep 10
done
```

在 tmux 視窗中執行 `ompweb-host-run`；按下 Ctrl-C 可停止守護行程及其對話。重新開機或登出後請再次啟動。若登入鑰匙圈因閒置或睡眠而自動上鎖，SSH 金鑰通行碼與簽署功能將會失敗，直到您重新啟動它為止。

**Windows（登入時執行的排程工作）。** 在 PowerShell 中，將 `$dir` 設定為解壓縮後的發行版路徑：

```powershell
$dir = "$env:LOCALAPPDATA\ompweb-windows-x64"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\logs" | Out-Null
Set-Content "$dir\ompweb-host.ps1" @'
# Starts `ompweb host` again 10 s after it fails, and stops on exit 0 (a newer link replaced it).
# Output goes to ~\.omp\agent\logs\ompweb-host.log, moved to .log.1 past 10 MB (checked between restarts).
# For a plain http:// server URL, put --allow-http after `host` below.
$log = "$env:USERPROFILE\.omp\agent\logs\ompweb-host.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.1" -Force }
  & "$PSScriptRoot\ompweb.exe" host 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 10
}
'@
Register-ScheduledTask -TaskName ompweb-host -Force `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\ompweb-host.ps1`"") `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries)
Start-ScheduledTask ompweb-host
```

使用 `Stop-ScheduledTask ompweb-host` 停止排程工作，接著透過 `Get-Process ompweb | Where-Object Path -eq "$env:LOCALAPPDATA\ompweb-windows-x64\ompweb.exe" | Stop-Process` 結束執行中的主機（僅結束此發行版的 `ompweb.exe`；請依 `$dir` 調整路徑）。使用 `Unregister-ScheduledTask ompweb-host` 即可將其移除。

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
- **遠端主機**：連結其他機器（例如 MacBook）並從單一 ompweb 在該機器上執行對話。側邊欄會依主機將對話分組。請參閱[在其他機器上執行對話](#在其他機器上執行對話)。
- **使用量與分析**：位於**設定 → 使用量**的儀表板，提供 Token 數、花費、快取節省分析，並依供應商／模型／日期／專案細分統計，具備 SQLite 資料持久化儲存。
- **Windows 系統匣與服務**：背景服務、系統匣圖示、登入自動啟動，以及桌面／開始功能表捷徑（Windows）。
- **macOS launchd 服務**：LaunchAgent 服務，於登入時啟動、異常終止時自動重新啟動，並在 `~/Library/Logs/ompweb` 下記錄記錄檔。
- **Linux systemd 服務與系統匣**：使用者服務，於登入時啟動、異常終止時自動重新啟動，並附帶具備服務控制功能的 StatusNotifierItem 系統匣圖示（支援 KDE Plasma 與相容桌面環境）。
- **通知功能**：針對任務完成、等待使用者回覆、執行失敗與自動切換模型提供桌面與行動裝置（PWA）通知，在 HTTPS 環境下支援 Web Push 推播。請參閱[通知功能](#通知功能)。
- **Web 設定介面**（11 個分頁）：介面與行為、安全性與核准、AI 模型預設值、API 金鑰與供應商、使用量、代理與智慧功能（顧問、記憶、壓縮）、代理、擴充功能與工具（MCP、技能、外掛程式）、主機、通知、系統。
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
開發伺服器不會接管本機守護行程：只有正式環境的網頁伺服器會寫入守護行程的 `host.json`，因此「本機」在開發環境中會顯示為離線，而守護行程會保持與您已安裝的 ompweb 連結。

`npm run dev` 以 Bun 熱重載（hot reload）方式執行伺服器。`npm run build` 將瀏覽器端應用打包至 `dist/`，`npm start` 則在 30177 連接埠提供該產物（可用 `npm run smoke` 檢查結果）。`npm run dev:lan` 會將開發伺服器繫結至所有網路介面。`npm run build:binary` 會將適用於本機的[單一二進位檔](#單一二進位檔)建置到 `release/`（可使用 `-- --target bun-linux-arm64` 等參數為其他平台建置；`npm run smoke -- --binary release/ompweb-linux-x64/ompweb` 進行檢查）。

### 檢查與測試

```bash
npm run typecheck   # 型別檢查（TypeScript）
npm run lint        # ESLint 程式碼檢查
npm test            # 執行測試套件（bun test）
```

## 授權條款與致謝

- 分支（fork）自 [agegr/pi-web](https://github.com/agegr/pi-web)（MIT 授權）並針對 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 進行調整。
- 採用 [MIT 授權條款](./LICENSE)釋出。
