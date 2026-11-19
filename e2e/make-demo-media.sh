#!/bin/sh
# Generates the made-up song library used for the README / portfolio
# screenshots in e2e/demo-media (needs Docker). Every name and lyric is invented.
set -e
cd "$(dirname "$0")"
mkdir -p demo-media
docker run --rm -v "$(pwd)/demo-media:/m" -w /m alpine:3.22 sh -c '
  set -e
  apk add -q ffmpeg font-noto-cjk >/dev/null
  font=$(fc-list | grep -m1 -i "NotoSansCJK-Bold\|NotoSansCJK" | cut -d: -f1)
  line() { echo "drawtext=fontfile=$font:text=$1:fontsize=$2:fontcolor=$3:borderw=6:bordercolor=0x1a1030:x=(w-text_w)/2:y=$4"; }
  ffmpeg -f lavfi -i "gradients=size=1280x720:rate=25:duration=60:c0=0x2b1055:c1=0x7597de:speed=0.01" \
    -f lavfi -i sine=frequency=330:duration=60 \
    -vf "$(line "夏夜的風" 44 white 60),$(line "Demo Band" 28 0xddddff 120),$(line "晚風吹過了街角的燈" 64 0x7cf3ff 520),$(line "我們把今天唱成一首歌" 64 white 610)" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -loglevel error -y demo.mp4
  ffmpeg -f lavfi -i sine=frequency=660:duration=60 -c:a aac -loglevel error -y orig.m4a
  mkdir -p 華語 日本語 English
  for n in "華語/Demo Band - 夏夜的風" "華語/Demo Band - 星期五的晚上" "華語/小行星樂團 - 慢慢走" "華語/小行星樂團 - 給未來的明信片" \
    "華語/示範歌手 - 一起唱吧" "華語/示範歌手 - 雨後的操場" \
    "日本語/サンプルズ - 夜明けのメロディ" "日本語/サンプルズ - 青い風" "日本語/テスト少女 - ひかりの歌" \
    "English/The Placeholders - Neon Lights" "English/The Placeholders - Weekend Drive" "English/Lorem Ipsum - Sing It Loud"; do
    cp demo.mp4 "$n.mp4"
  done
  mv orig.m4a "華語/Demo Band - 夏夜的風_original.m4a"
  rm demo.mp4
'
echo "demo media ready: $(find demo-media -name "*.mp4" | wc -l) songs"
