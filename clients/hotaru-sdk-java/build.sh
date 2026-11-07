#!/usr/bin/env bash
# Build, test and package the Hotaru Java SDK.
#
#   bash build.sh            # version 0.0.0
#   bash build.sh 1.2.3      # stamps 1.2.3 into the manifest and the jar names
#
# Produces dist/:
#   hotaru-sdk-java-<version>.jar           classes (auth + IRC client + REST client)
#   hotaru-sdk-java-<version>-sources.jar   sources
#   SHA256SUMS.txt                             checksums
# Requires a JDK 21 (`javac`/`jar` on PATH) and nothing else — no Maven, no Gradle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-0.0.0}"

# Everything below uses paths relative to the module root: Windows javac cannot
# resolve the POSIX-style absolute paths that Git Bash produces with `pwd`.
cd "$ROOT"

# Classpath separator differs: Windows java.exe wants ";", POSIX uses ":".
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) CP_SEP=";" ;;
  *) CP_SEP=":" ;;
esac

rm -rf out dist
mkdir -p out/main out/test-classes dist

echo "==> compiling main sources (release 21)"
find src/main/java -name '*.java' | sort > sources-main.txt
javac --release 21 -Xlint:all -encoding UTF-8 -d out/main "@sources-main.txt"

echo "==> compiling test sources"
find src/test/java -name '*.java' | sort > sources-test.txt
javac --release 21 -Xlint:all -encoding UTF-8 -cp out/main -d out/test-classes "@sources-test.txt"

echo "==> running offline self-tests"
TESTS=(
  cn.seiua.mcauth.ServerHashSelfTest
  cn.seiua.mcauth.EndToEndSelfTest
  cn.seiua.mcauth.bridge.BridgeSelfTest
  cn.seiua.mcauth.bridge.ProfileResolverSelfTest
  cn.seiua.irc.IrcClientSelfTest
  cn.seiua.irc.rest.IrcRestClientSelfTest
)
for test in "${TESTS[@]}"; do
  echo "--- $test"
  java -cp "out/main${CP_SEP}out/test-classes" "$test"
done

echo "==> packaging $VERSION"
cat > out/MANIFEST.MF <<EOF
Manifest-Version: 1.0
Implementation-Title: Hotaru Java SDK
Implementation-Version: $VERSION
Implementation-Vendor: seiua
EOF

jar --create --file "dist/hotaru-sdk-java-$VERSION.jar" --manifest out/MANIFEST.MF -C out/main .
jar --create --file "dist/hotaru-sdk-java-$VERSION-sources.jar" -C src/main/java .
(cd dist && sha256sum ./*.jar > SHA256SUMS.txt)

echo
echo "==> artifacts"
ls -lh dist
echo "==> done ($VERSION)"
