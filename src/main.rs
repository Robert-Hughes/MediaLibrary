use ply_engine::prelude::*;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use walkdir::WalkDir;
use image::ImageReader;
use macroquad::texture::Texture2D;
use macroquad::prelude::*;

#[derive(Clone)]
struct Photo {
    relative_path: String,
    thumbnail: Option<Texture2D>,
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
    let mut state = AppState::Default;

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
                        ui.element().button("Open Folder", |b| b
                            .on_click(|| {
                                if let Some(folder) = rfd::FileDialog::new().pick_folder() {
                                    let progress = format!("Scanning {}...", folder.display());
                                    state = AppState::Loading { progress };
                                    let tx = tx.clone();
                                    thread::spawn(move || {
                                        let mut photos = Vec::new();
                                        let mut count = 0;
                                        for entry in WalkDir::new(&folder) {
                                            if let Ok(entry) = entry {
                                                if entry.file_type().is_file() {
                                                    let path = entry.path();
                                                    if let Some(ext) = path.extension() {
                                                        if matches!(ext.to_str(), Some("jpg" | "jpeg" | "png" | "gif" | "bmp")) {
                                                            count += 1;
                                                            let _ = tx.send(AppState::Loading { progress: format!("Scanning... {} files found", count) });
                                                            // Load thumbnail
                                                            if let Ok(img) = ImageReader::open(path).and_then(|i| i.decode()) {
                                                                let img = img.resize(100, 100, image::imageops::FilterType::Lanczos3);
                                                                let rgba = img.to_rgba8();
                                                                let texture = Texture2D::from_rgba8(img.width() as u16, img.height() as u16, &rgba);
                                                                let relative_path = path.strip_prefix(&folder).unwrap().to_string_lossy().to_string();
                                                                photos.push(Photo { relative_path, thumbnail: Some(texture) });
                                                            } else {
                                                                let relative_path = path.strip_prefix(&folder).unwrap().to_string_lossy().to_string();
                                                                photos.push(Photo { relative_path, thumbnail: None });
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        let _ = tx.send(AppState::Loaded { folder, photos });
                                    });
                                }
                            })
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
                        ui.element().height(50).background(Color::rgba(0.2, 0.2, 0.2, 1.0))
                            .children(|ui| {
                                ui.text(&format!("Folder: {}", folder.display()), |t| t.font_size(16).color(WHITE));
                                ui.element().width(grow!());
                                ui.element().button("Close Folder", |b| b
                                    .on_click(|| {
                                        state = AppState::Default;
                                    })
                                );
                                ui.element().button("Open New Folder", |b| b
                                    .on_click(|| {
                                        if let Some(new_folder) = rfd::FileDialog::new().pick_folder() {
                                            let progress = format!("Scanning {}...", new_folder.display());
                                            state = AppState::Loading { progress };
                                            let tx = tx.clone();
                                            thread::spawn(move || {
                                                let mut photos = Vec::new();
                                                let mut count = 0;
                                                for entry in WalkDir::new(&new_folder) {
                                                    if let Ok(entry) = entry {
                                                        if entry.file_type().is_file() {
                                                            let path = entry.path();
                                                            if let Some(ext) = path.extension() {
                                                                if matches!(ext.to_str(), Some("jpg" | "jpeg" | "png" | "gif" | "bmp")) {
                                                                    count += 1;
                                                                    let _ = tx.send(AppState::Loading { progress: format!("Scanning... {} files found", count) });
                                                                    // Load thumbnail
                                                                    if let Ok(img) = ImageReader::open(path).and_then(|i| i.decode()) {
                                                                        let img = img.resize(100, 100, image::imageops::FilterType::Lanczos3);
                                                                        let rgba = img.to_rgba8();
                                                                        let texture = Texture2D::from_rgba8(img.width() as u16, img.height() as u16, &rgba);
                                                                        let relative_path = path.strip_prefix(&new_folder).unwrap().to_string_lossy().to_string();
                                                                        photos.push(Photo { relative_path, thumbnail: Some(texture) });
                                                                    } else {
                                                                        let relative_path = path.strip_prefix(&new_folder).unwrap().to_string_lossy().to_string();
                                                                        photos.push(Photo { relative_path, thumbnail: None });
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                let _ = tx.send(AppState::Loaded { folder: new_folder, photos });
                                            });
                                        }
                                    })
                                );
                            });
                        ui.element().height(grow!())
                            .scroll_view(|sv| {
                                for photo in photos {
                                    ui.element().height(60).layout(|l| l.direction(Horizontal))
                                        .children(|ui| {
                                            if let Some(tex) = &photo.thumbnail {
                                                ui.image(tex, |i| i.size(50, 50));
                                            } else {
                                                ui.element().size(50, 50).background(Color::gray());
                                            }
                                            ui.element().width(10);
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
