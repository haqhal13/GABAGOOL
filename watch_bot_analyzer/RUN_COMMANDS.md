# Quick Commands (from watch_bot_analyzer directory)

## Run the pipeline:
```bash
python3 run.py
```

## View results (after running):

### View graphs:
```bash
open output/*.png
```

### View confidence scores:
```bash
cat output/params_latest.json | python3 -m json.tool
```

### List all output files:
```bash
ls -lh output/
```

## One-liner (run + view graphs):
```bash
python3 run.py && open output/*.png
```
