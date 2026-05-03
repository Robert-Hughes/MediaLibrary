use ply_engine::prelude::*;

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

    loop {
        clear_background(BLACK);

        let mut ui = ply.begin();

        ui.element().width(grow!()).height(grow!())
            .layout(|l| l.align(CenterX, CenterY))
            .children(|ui| {
                ui.text("Media Library", |t| t
                    .font_size(40)
                    .color(WHITE)
                );
                ui.text("Ply engine starter app", |t| t
                    .font_size(24)
                    .color(Color::rgba(1.0, 1.0, 1.0, 0.8))
                );
            });

        ui.show(|_| {}).await;
        next_frame().await;
    }
}
