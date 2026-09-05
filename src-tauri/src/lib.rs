mod omp;
mod rpc_frame;
mod sessions;
mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      shell::setup(app)?;
      Ok(())
    })
    .manage(omp::OmpState(std::sync::Mutex::new(None)))
    .invoke_handler(omp::handlers())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
