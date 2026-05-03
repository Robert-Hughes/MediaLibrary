use ply_engine::prelude::*;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use walkdir::WalkDir;

#[derive(Clone)]
struct Photo {
    relative_path: String,
}

enum AppState {
    Default,
    Loading { progress: String },
    Loaded { folder: PathBuf, photos: Vec<Photo> },
}

fn window_conf() -> macroquad::conf::Conf {
    macroquad::conf::Conf {
        miniquad_conf: miniquad::conf::Conf {
            window_title: "MediaLibrary".to_owned(),
            window_width: 1024,
            window_height: 768,
            high_dpi: true,
            sample_count: 4,
            platform: miniquad::conf::Platform {
                webgl_version: miniquad::conf::WebGLVersion::WebGL2,
                ..Default::default()
            },
            ..Default::default()
        },
        draw_call_vertex_capacity: 100000,
        draw_call_index_capacity: 100000,
        ..Default::default()
    }
}

#[macroquad::main(window_conf)]
async fn main() {
    static DEFAULT_FONT: FontAsset = FontAsset::Path("assets/fonts/arial.ttf");
    let mut ply = Ply::<()>::new(&DEFAULT_FONT).await;

    let (tx, rx) = mpsc::channel();
    let mut state = AppState::Loading { progress: "Scanning...".to_string() };
    let tx_clone = tx.clone();
    thread::spawn(move || {
        let folder = PathBuf::from("C:\\Users\\xman2\\Pictures"); // Hardcoded for testing
        let mut photos = Vec::new();
        let mut count = 0;
        for entry in WalkDir::new(&folder) {
            if let Ok(entry) = entry {
                if entry.file_type().is_file() {
                    let path = entry.path();
                    if let Some(ext) = path.extension() {
                        if matches!(ext.to_str(), Some("jpg" | "jpeg" | "png" | "gif" | "bmp")) {
                            count += 1;
                            let _ = tx_clone.send(AppState::Loading { progress: format!("Scanning... {} files found", count) });
                            let relative_path = path.strip_prefix(&folder).unwrap().to_string_lossy().to_string();
                            photos.push(Photo { relative_path });
                        }
                    }
                }
            }
        }
        let _ = tx_clone.send(AppState::Loaded { folder, photos });
    });

    loop {
        clear_background(BLACK);

        // Check for updates from background thread
        if let Ok(new_state) = rx.try_recv() {
            state = new_state;
        }

        let mut ui = ply.begin();

        match &mut state {
            AppState::Default => {
                ui.element().width(grow!()).height(grow!())
                    .layout(|l| l.align(CenterX, CenterY))
                    .children(|ui| {
                        ui.text("Media Library", |t| t
                            .font_size(40)
                            .color(WHITE)
                        );
                        ui.text("Loading photos...", |t| t
                            .font_size(24)
                            .color(Color::rgba(1.0, 1.0, 1.0, 0.8))
                        );
                    });
            }
            AppState::Loading { progress } => {
                ui.element().width(grow!()).height(grow!())
                    .layout(|l| l.align(CenterX, CenterY))
                    .children(|ui| {
                        ui.text("Loading...", |t| t
                            .font_size(30)
                            .color(WHITE)
                        );
                        ui.text(progress, |t| t
                            .font_size(20)
                            .color(Color::rgba(1.0, 1.0, 1.0, 0.8))
                        );
                    });
            }
            AppState::Loaded { folder, photos } => {
                ui.element().width(grow!()).height(grow!())
                    .children(|ui| {
                        ui.element().height(fixed!(50.0)).background_color(Color::rgba(0.2, 0.2, 0.2, 1.0))
                            .children(|ui| {
                                ui.text(&format!("Folder: {}", folder.display()), |t| t.font_size(16).color(WHITE));
                                ui.element().width(grow!());
                                ui.text("Close Folder", |t| t.color(WHITE));
                                ui.text("Open New Folder", |t| t.color(WHITE));
                            });
                        ui.element().height(grow!())
                            .children(|ui| {
                                        for photo in photos {
                                    ui.element().height(fixed!(60.0))
                                        .children(|ui| {
                                            // Placeholder for thumbnail
                                            ui.element().width(fixed!(50.0)).height(fixed!(50.0)).background_color(Color::u_rgba(64, 64, 64, 255));
                                            ui.element().width(fixed!(10.0));
                                            ui.text(&photo.relative_path, |t| t.font_size(14).color(WHITE));
                                        });
                                }
                            });
                    });
            }
        }

        ui.show(|_| {}).await;
        next_frame().await;
    }
}
