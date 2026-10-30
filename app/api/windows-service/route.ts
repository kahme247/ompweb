import {
  getWebServiceStatus,
  installTrayShortcuts,
  uninstallTrayShortcuts,
  toggleAutostart,
  startTrayService,
  stopTrayService,
  restartTrayService,
} from "@/lib/windows-service";

export const dynamic = "force-dynamic";

interface WindowsServiceRequestBody {
  action?: "install" | "uninstall" | "toggle-autostart" | "start" | "stop" | "restart";
  port?: number;
  hostname?: string;
  mode?: "start" | "dev";
  autostart?: boolean;
  startImmediately?: boolean;
  cleanConfig?: boolean;
}

export async function GET(): Promise<Response> {
  const status = await getWebServiceStatus();
  return Response.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as WindowsServiceRequestBody;
    const { action } = body;

    if (!action) {
      return Response.json(
        { error: "Missing required 'action' parameter.", code: "missing_action" },
        { status: 400 }
      );
    }

    let result: { success: boolean; message?: string } = { success: true };

    switch (action) {
      case "install":
        result = await installTrayShortcuts({
          port: body.port,
          hostname: body.hostname,
          mode: body.mode,
          autostart: body.autostart,
          startImmediately: body.startImmediately,
        });
        break;

      case "uninstall":
        result = await uninstallTrayShortcuts({
          cleanConfig: body.cleanConfig,
        });
        break;

      case "toggle-autostart": {
        const targetState = body.autostart !== false;
        result = await toggleAutostart(targetState);
        break;
      }

      case "start":
        result = await startTrayService({ openBrowser: false });
        break;

      case "stop":
        result = await stopTrayService();
        break;

      case "restart":
        result = await restartTrayService();
        break;

      default:
        return Response.json(
          { error: `Unknown action '${String(action)}'.`, code: "invalid_action" },
          { status: 400 }
        );
    }

    const updatedStatus = await getWebServiceStatus();

    if (!result.success) {
      return Response.json(
        {
          error: result.message || `Action '${action}' failed.`,
          code: "action_failed",
          status: updatedStatus,
        },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      message: result.message,
      status: updatedStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message, code: "server_error" }, { status: 500 });
  }
}
