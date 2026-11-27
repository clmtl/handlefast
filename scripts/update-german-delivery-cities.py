#!/usr/bin/env python3
"""Build approximate delivery city centres from the CC BY 4.0 GeoNames postal data."""
from collections import defaultdict
from io import BytesIO
import json
from pathlib import Path
import re
from statistics import mean
import unicodedata
from urllib.request import urlopen
from zipfile import ZipFile


def normalize(city):
    return "".join(character.lower() for character in unicodedata.normalize("NFD", city)
                   if unicodedata.category(character)[0] in ("L", "N"))


source = "https://download.geonames.org/export/zip/DE.zip"
with urlopen(source, timeout=30) as response, ZipFile(BytesIO(response.read())) as archive:
    records = archive.read("DE.txt").decode().splitlines()

cities = defaultdict(lambda: defaultdict(set))
for record in records:
    country, postal, place, _, state, _, _, _, county, latitude, longitude, _ = record.split("\t")
    if country == "DE" and re.fullmatch(r"\d{5}", postal) and place and latitude and longitude:
        cities[normalize(place)][(state, county)].add((postal, float(latitude), float(longitude)))

output = Path(__file__).resolve().parents[1] / "convex/lib/data/germanDeliveryCities.json"
output.parent.mkdir(parents=True, exist_ok=True)
with output.open("w", encoding="utf-8") as destination:
    destination.write("{\n")
    lines = []
    for name, localities in sorted(cities.items()):
        centres = []
        for postal_points in localities.values():
            points = {(lat, lng) for _, lat, lng in postal_points}
            centre = [round(mean(p[1] for p in points), 3), round(mean(p[0] for p in points), 3)]
            if len(localities) > 1:
                centre.append(sorted({postal for postal, _, _ in postal_points}))
            centres.append(centre)
        lines.append("  " + json.dumps(name, ensure_ascii=False) + ": " + json.dumps(centres, separators=(",", ":")))
    destination.write(",\n".join(lines) + "\n}\n")
