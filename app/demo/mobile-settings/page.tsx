import { MobileSettingsDemo } from "@/components/MobileSettingsDemo";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "移动端设置 UI 交互 Demo | omp-web",
};

export default function MobileSettingsDemoPage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "20px 16px",
      }}
    >
      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>
          📱 移动端设置重构交互 Demo
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, maxWidth: 500 }}>
          采用 <strong>导航栈下钻 (Drill-Down Stack)</strong> + <strong>单一滚动容器 (Single Scroll)</strong> + <strong>内嵌分组卡片 (Inset Grouped Cards)</strong> 设计。
        </p>
      </div>

      <MobileSettingsDemo />
    </main>
  );
}
