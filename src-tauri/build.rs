fn main() {
    tauri_build::build();

    // Tauri links its Windows resource (including the Common Controls v6
    // activation manifest) only into declared application binaries. Cargo's
    // unit-test harness for this library is another executable and can also
    // make Tauri's native TaskDialog error path reachable. Apply the same
    // generated resource to every linkable target in this package; rlibs do
    // not perform a native link, so this has no effect on the library artifact.
    #[cfg(target_os = "windows")]
    {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        println!("cargo:rustc-link-arg={}", resource.display());
    }
}
