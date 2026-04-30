use crate::mapping::Override;

#[derive(Debug)]
pub struct Args {
    pub fbi_url: String,
    pub run_id: u32,
    pub overrides: Vec<Override>,
}

pub fn parse_args(argv: &[String]) -> Result<Args, String> {
    if argv.len() < 2 {
        return Err("usage: fbi-tunnel <fbi-url> <run-id> [-L localport:remoteport]...".into());
    }
    let fbi_url = argv[0].clone();
    let run_id: u32 = argv[1]
        .parse()
        .map_err(|_| format!("invalid run id {:?}", argv[1]))?;

    let mut overrides = Vec::new();
    let mut i = 2usize;
    while i < argv.len() {
        match argv[i].as_str() {
            "-L" => {
                i += 1;
                if i >= argv.len() {
                    return Err("-L requires a value".into());
                }
                overrides.push(parse_l_flag(&argv[i])?);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
        i += 1;
    }

    Ok(Args {
        fbi_url,
        run_id,
        overrides,
    })
}

fn parse_l_flag(v: &str) -> Result<Override, String> {
    let parts: Vec<&str> = v.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("-L must be localport:remoteport, got {v:?}"));
    }
    let local: u16 = parts[0]
        .parse()
        .map_err(|_| format!("invalid local port in {v:?}"))?;
    let remote: u16 = parts[1]
        .parse()
        .map_err(|_| format!("invalid remote port in {v:?}"))?;
    if local == 0 || remote == 0 {
        return Err(format!("port must be > 0 in {v:?}"));
    }
    Ok(Override { local, remote })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &[&str]) -> Vec<String> {
        s.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn minimal_args() {
        let a = parse_args(&argv(&["http://fbi:3000", "42"])).unwrap();
        assert_eq!(a.fbi_url, "http://fbi:3000");
        assert_eq!(a.run_id, 42);
        assert!(a.overrides.is_empty());
    }

    #[test]
    fn l_flag_parsed() {
        let a = parse_args(&argv(&["http://fbi:3000", "42", "-L", "8080:5173"])).unwrap();
        assert_eq!(a.overrides.len(), 1);
        assert_eq!(a.overrides[0].local, 8080);
        assert_eq!(a.overrides[0].remote, 5173);
    }

    #[test]
    fn multiple_l_flags() {
        let a = parse_args(&argv(&[
            "http://fbi:3000",
            "42",
            "-L",
            "8080:5173",
            "-L",
            "9230:9229",
        ]))
        .unwrap();
        assert_eq!(a.overrides.len(), 2);
    }

    #[test]
    fn too_few_args_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000"])).is_err());
        assert!(parse_args(&argv(&[])).is_err());
    }

    #[test]
    fn invalid_run_id_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "abc"])).is_err());
    }

    #[test]
    fn l_without_value_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L"])).is_err());
    }

    #[test]
    fn l_malformed_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L", "notaport"])).is_err());
    }

    #[test]
    fn l_zero_port_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "-L", "0:5173"])).is_err());
    }

    #[test]
    fn unknown_arg_is_error() {
        assert!(parse_args(&argv(&["http://fbi:3000", "42", "--foo"])).is_err());
    }
}
