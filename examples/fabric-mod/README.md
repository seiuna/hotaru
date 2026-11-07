# Fabric integration examples (not compiled)

These files show how a Fabric client mod wires the Hotaru auth library and its loopback login bridge.
They are **documentation, not part of the library**: the library itself has no Minecraft, Fabric or
launcher dependency — its whole integration surface is `cn.seiua.mcauth.AccessTokenProvider`, one
method.

| File | Shows |
| --- | --- |
| `HotaruAuthClient.java.example` | `SessionProvider` implemented over `MinecraftClient.getInstance().getSession()`, plus mod initialisation |
| `HotaruAuthBridgeExample.java.example` | Starting `LocalAuthBridge` so the admin console can log in through the game, with an in-game approval screen |

## Why they are `.java.example`

Compiling them needs Minecraft + Fabric on the classpath (Loom/`fabric-loader`), which would make the
library impossible to build without a game installation. Copy the file into your mod's client source
set, rename it to `.java`, adjust the package, and add the Fabric API dependency.

## The only thing the library asks of your code

```java
AccessTokenProvider provider = () -> MinecraftClient.getInstance().getSession().getAccessToken();
TokenResponse tokens = authClient.authenticate(provider);
```

If you already know the UUID and username, implement `SessionProvider` instead (it extends
`AccessTokenProvider`) and the library skips one Mojang profile lookup. Nothing else about Minecraft
leaks into the library: no `net.minecraft` import exists anywhere under `clients/hotaru-sdk-java/src`.
