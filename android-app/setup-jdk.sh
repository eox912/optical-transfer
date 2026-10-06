#!/usr/bin/env bash
# setup-jdk.sh —— 给安卓构建准备 JDK 21
#
#   bash setup-jdk.sh
#
# 为什么需要：Capacitor 的 filesystem / share 插件把
# `sourceCompatibility/targetCompatibility` 设成了 **Java 21**，
# 所以 Gradle 工具链要求 languageVersion=21。本机默认只有 Java 17，
# 而 Gradle 的自动下载在沙箱里也不通（要写 ~/.gradle 之外的目录、且源很慢）。
#
# 这里从**清华 Adoptium 镜像**取一个 JDK 21 解到 /tmp，不动系统默认 JDK，
# 也不需要 sudo。装完 gradle.properties 里的 org.gradle.java.installations.paths
# 会指向它（见该文件里的注释）。
set -euo pipefail

DEST="${JDK21_DEST:-/tmp/jdk21}"
BASE="https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/aarch64/mac"

if [ -x "$DEST/bin/java" ] || [ -x "$DEST/Contents/Home/bin/java" ]; then
  JH="$DEST"
  [ -x "$DEST/Contents/Home/bin/java" ] && JH="$DEST/Contents/Home"
  echo "JDK 21 已就绪：$JH"
  "$JH/bin/java" -version 2>&1 | head -2
  exit 0
fi

echo "==> 从清华镜像查找 JDK 21 包"
FILE="$(curl -sSL -m 20 "$BASE/" | grep -oE 'OpenJDK21U[^"<]*\.tar\.gz' | sort -u | tail -1)"
if [ -z "$FILE" ]; then
  echo "镜像上没有找到 JDK 21 包，请手动下载后解到 $DEST" >&2
  exit 1
fi
echo "    找到 $FILE"

mkdir -p /tmp/jdk21dl
cd /tmp/jdk21dl
if [ ! -f "$FILE" ]; then
  echo "==> 下载"
  curl -sSL -o "$FILE" "$BASE/$FILE" -w "    %{size_download} 字节，%{speed_download} B/s\n"
fi

echo "==> 解包到 $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$FILE" -C "$DEST" --strip-components=1

JH="$DEST"
[ -x "$DEST/Contents/Home/bin/java" ] && JH="$DEST/Contents/Home"
echo "==> 完成：$JH"
"$JH/bin/java" -version 2>&1 | head -2
