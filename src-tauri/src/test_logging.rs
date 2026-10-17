//! Thread-local log capture shared by regressions; never emits test stderr.
use std::cell::RefCell;
thread_local! {
    static RECORDS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}
struct Logger;
impl log::Log for Logger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        RECORDS.with(|records| {
            if let Some(records) = records.borrow_mut().as_mut() {
                records.push(record.args().to_string());
            }
        });
    }
    fn flush(&self) {}
}
pub(crate) fn capture<T>(run: impl FnOnce() -> T) -> (T, Vec<String>) {
    static LOGGER: Logger = Logger;
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        log::set_logger(&LOGGER).unwrap();
        log::set_max_level(log::LevelFilter::Info);
    });
    RECORDS.with(|records| *records.borrow_mut() = Some(Vec::new()));
    let result = run();
    let records = RECORDS.with(|records| records.borrow_mut().take().unwrap());
    (result, records)
}
