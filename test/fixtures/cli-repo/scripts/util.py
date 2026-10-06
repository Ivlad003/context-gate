def bump(v, part="minor"):
    a, b, c = [int(x) for x in v.split(".")]
    return f"{a}.{b + 1}.0" if part == "minor" else f"{a + 1}.0.0"
