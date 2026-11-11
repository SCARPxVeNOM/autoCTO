//! OutLayer entry point: coin state on stdin, one proposed move on stdout.

use std::io::{self, Read, Write};

use autocto_brain::{Env, run};

#[cfg(target_os = "wasi")]
struct WasiHttp;

#[cfg(target_os = "wasi")]
impl autocto_brain::Http for WasiHttp {
    fn post_json(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<String, String> {
        let mut req = wasi_http_client::Client::new()
            .post(url)
            .header("Content-Type", "application/json")
            .connect_timeout(std::time::Duration::from_secs(20));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req.body(body.as_bytes()).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let bytes = resp.body().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if status >= 400 {
            return Err(format!("http {status}: {}", autocto_brain::truncate(&text, 300)));
        }
        Ok(text)
    }

    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
        let mut req = wasi_http_client::Client::new().get(url).connect_timeout(std::time::Duration::from_secs(20));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let bytes = resp.body().map_err(|e| e.to_string())?;
        if status >= 400 {
            return Err(format!("http {status}"));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).ok();
    let env = Env::from_process();
    #[cfg(target_os = "wasi")]
    let http = WasiHttp;
    #[cfg(not(target_os = "wasi"))]
    let http = autocto_brain::NativeHttp;
    let out = run(&input, &env, &http);
    // stdout must be exactly one JSON value.
    print!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "null".into()));
    io::stdout().flush().ok();
}
