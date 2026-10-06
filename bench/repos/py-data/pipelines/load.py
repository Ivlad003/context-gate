import polars as pl

def load(path: str) -> pl.DataFrame:
    return pl.read_parquet(path)
