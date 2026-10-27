// BepInEx 5 plugin: renders the cult base with the game's own camera, lighting and shaders,
// looking down at 45° without perspective (the planner's projection), and dumps game data.
//
// Flow: on the main menu it continues the configured save slot, waits for the base to settle,
// switches saving off, then runs the enabled jobs:
//   Structures   structures.json: every placed structure's type, cell, footprint and flags
//   Translations i18n.json: every localisation term in every language the game ships
//   Buildings    buildings/<TYPE>.png: each buildable structure alone, as the game draws it,
//                cut out exactly from renders over black and white; buildings/buildings.json
//                holds each sprite's anchor (the centre of the footprint's first cell)
//   Backgrounds  landN.png per Woolhaven land level (none bought .. all three, switched in memory
//                with DLCLandController), the game's grid per level in grid.json, and gridN.png
//                with the game's build-mode tile on every cell
// Then writes capture.json and quits.
// It never writes the save: SaveAndLoad, metadata and persistence saves are blocked while installed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using I2.Loc;
using MMTools;
using src.Managers;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.Rendering.PostProcessing;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.SceneManagement;

[BepInPlugin("chrsnv.cotlplanner.capture", "COTL Planner Capture", "1.1.0")]
public class PlannerCapture : BaseUnityPlugin
{
    // Area to capture, in the planner's projected world units: u = x, v = cos45 * (y - z).
    // The tools/background box (base region plus a margin), extended south over the extra land.
    const float U0 = -33.858737f, U1 = 34.224524f, V0 = -46f, V1 = 15.101617f;
    const float K = 0.70710678f;

    // Fixed structures that belong to the default base and stay in the clean capture. The Temple is
    // left out: it can be moved and upgraded, so the planner draws it like any other building.
    static readonly HashSet<string> Keep = new HashSet<string> {
        "SHRINE", "SHRINE_II", "SHRINE_III", "SHRINE_IV", "SHRINE_BASE",
        "TEMPLE_BASE", "TEMPLE_BASE_EXTENSION1", "TEMPLE_BASE_EXTENSION2", "COLLECTED_RESOURCES_CHEST", "MISSION_SHRINE",
        "DANCING_FIREPIT", "FEAST_TABLE", "RATAU_SHRINE", "PLACEMENT_REGION", "FIRE", "FISHING_SPOT",
    };

    ConfigEntry<int> slot, width;
    ConfigEntry<float> settle;
    ConfigEntry<bool> autoLoad, forceDay, quitAfter, doStructures, doTranslations, doBuildings, doBackgrounds;
    string outDir;
    bool started, done;

    void Awake()
    {
        slot = Config.Bind("Capture", "SaveSlot", 0, "Save slot to continue from the main menu.");
        width = Config.Bind("Capture", "Width", 6144, "Background width in pixels (height follows the area's aspect).");
        settle = Config.Bind("Capture", "SettleSeconds", 25f, "Seconds to wait in the base before capturing.");
        autoLoad = Config.Bind("Capture", "AutoLoad", true, "Continue the save automatically from the main menu.");
        forceDay = Config.Bind("Capture", "ForceDay", true, "Move the clock to the afternoon before capturing.");
        quitAfter = Config.Bind("Capture", "QuitAfter", true, "Quit the game after capturing.");
        doStructures = Config.Bind("Jobs", "Structures", true, "structures.json: placed structures with their cells.");
        doTranslations = Config.Bind("Jobs", "Translations", true, "i18n.json: every localisation term in every language.");
        doBuildings = Config.Bind("Jobs", "Buildings", true, "buildings/: every buildable structure rendered alone.");
        doBackgrounds = Config.Bind("Jobs", "Backgrounds", true, "landN.png, grid.json, gridN.png per land level.");
        outDir = Path.Combine(Paths.PluginPath, "PlannerCapture");
        Directory.CreateDirectory(outDir);
        new Harmony("chrsnv.cotlplanner.capture").PatchAll(typeof(PlannerCapture));
        SceneManager.sceneLoaded += OnSceneLoaded;
        Logger.LogInfo("loaded; saving is blocked while this plugin is installed");
    }

    [HarmonyPrefix, HarmonyPatch(typeof(SaveAndLoad), "Saving")] static bool NoSave() => false;
    [HarmonyPrefix, HarmonyPatch(typeof(SaveAndLoad), nameof(SaveAndLoad.SaveMetaData))] static bool NoMeta() => false;
    [HarmonyPrefix, HarmonyPatch(typeof(PersistenceManager), nameof(PersistenceManager.Save))] static bool NoPersist() => false;

    void OnSceneLoaded(Scene scene, LoadSceneMode mode)
    {
        Logger.LogInfo($"scene loaded: {scene.name}");
        if (scene.name == "Main Menu" && autoLoad.Value && !started)
        {
            started = true;
            StartCoroutine(Continue());
        }
        if (scene.name == "Base Biome 1" && !done)
            StartCoroutine(CaptureWhenReady());
    }

    IEnumerator Continue()
    {
        yield return new WaitForSecondsRealtime(8f);
        Logger.LogInfo($"continuing save slot {slot.Value}");
        int s = slot.Value;
        SaveAndLoad.SAVE_SLOT = s;
        // same as the menu's Continue (LoadMenu.ContinueGame)
        MMTransition.Play(MMTransition.TransitionType.ChangeRoomWaitToResume, MMTransition.Effect.BlackFade, "Base Biome 1", 3f, "", () => SaveAndLoad.Load(s));
    }

    IEnumerator CaptureWhenReady()
    {
        float waited = 0f;
        while (!SaveAndLoad.Loaded && waited < 180f) { waited += Time.unscaledDeltaTime; yield return null; }
        Logger.LogInfo($"save loaded after {waited:0}s, settling {settle.Value}s");
        yield return new WaitForSecondsRealtime(settle.Value);
        DataManager.Instance.DisableSaving = true;
        if (forceDay.Value)
        {
            DataManager.Instance.CurrentGameTime = 560f; // mid-afternoon: phases are 240 units, afternoon starts at 480
            yield return new WaitForSecondsRealtime(6f);
        }
        if (doStructures.Value) Try("structures", DumpStructures);
        if (doTranslations.Value) Try("translations", DumpTranslations);
        if (doBuildings.Value) yield return CaptureBuildings();
        if (doBackgrounds.Value) yield return CaptureLands();
        Try("capture.json", () =>
        {
            int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
            File.WriteAllText(Path.Combine(outDir, "capture.json"),
                $"{{\"ppu\":{w / (U1 - U0):0.####},\"w\":{w},\"h\":{h},\"u_left\":{U0},\"v_top\":{V1},\"time\":\"{DateTime.Now:s}\"}}");
        });
        Logger.LogInfo("capture done");
        done = true;
        if (quitAfter.Value)
        {
            yield return new WaitForSecondsRealtime(1f);
            Application.Quit();
            yield return new WaitForSecondsRealtime(8f);
            // Quit is swallowed under Proton; saving is blocked, so ending the process loses nothing.
            System.Diagnostics.Process.GetCurrentProcess().Kill();
        }
    }

    void Try(string what, Action job)
    {
        try { job(); }
        catch (Exception e) { Logger.LogError($"{what}: {e}"); }
    }

    // ---------- data dumps ----------

    void DumpStructures()
    {
        var rows = new List<string>();
        foreach (var s in FindObjectsOfType<Structure>())
        {
            var d = s.Structure_Info;
            if (d == null) continue;
            bool movable = true, deletable = true;
            try
            {
                var info = StructuresData.GetInfoByType(s.Type, 0);
                if (info != null) { movable = info.CanBeMoved; deletable = info.isDeletable; }
            }
            catch { }
            rows.Add($"{{\"type\":\"{s.Type}\",\"x\":{d.GridTilePosition.x},\"y\":{d.GridTilePosition.y},\"w\":{d.Bounds.x},\"h\":{d.Bounds.y}," +
                     $"\"movable\":{Bool(movable)},\"deletable\":{Bool(deletable)},\"obstruction\":{Bool(d.IsObstruction)}}}");
        }
        File.WriteAllText(Path.Combine(outDir, "structures.json"), "[\n" + string.Join(",\n", rows) + "\n]");
        Logger.LogInfo($"structures.json: {rows.Count} structures");
    }

    void DumpTranslations()
    {
        var source = LocalizationManager.Sources.FirstOrDefault(s => s.mTerms.Any(t => t.Term.StartsWith("Structures/")));
        if (source == null) { Logger.LogWarning("no localisation source holds Structures/ terms"); return; }
        var terms = source.mTerms; // everything: building names and descriptions, build menu headers, UI words
        var json = new StringBuilder("{\"languages\":[");
        json.Append(string.Join(",", source.mLanguages.Select(l => $"{{\"name\":{Json(l.Name)},\"code\":{Json(l.Code)}}}")));
        json.Append("],\"terms\":{\n");
        json.Append(string.Join(",\n", terms.Select(t => $"{Json(t.Term)}:[{string.Join(",", t.Languages.Select(Json))}]")));
        json.Append("\n}}");
        File.WriteAllText(Path.Combine(outDir, "i18n.json"), json.ToString());
        Logger.LogInfo($"i18n.json: {terms.Count} terms in {source.mLanguages.Count} languages");
    }

    static string Bool(bool b) => b ? "true" : "false";

    static string Json(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c); else sb.Append(c); break;
            }
        }
        return sb.Append('"').ToString();
    }

    // ---------- building renders ----------

    IEnumerator CaptureBuildings()
    {
        var list = FindObjectOfType<TypeAndPlacementObjects>();
        var region = PlacementRegion.Instance;
        if (!list || !region) { Logger.LogWarning("no build list or placement region in the scene"); yield break; }
        string dir = Path.Combine(outDir, "buildings");
        Directory.CreateDirectory(dir);
        var cam = GameCamera();
        // The game puts a building's prefab, unrotated, at the centre of its footprint's first cell.
        // Cell (0,0) is open ground in the base, so the building gets the base's lighting there.
        Vector3 anchor = region.transform.TransformPoint(Vector3.zero);
        const int Layer = 31, Size = 1024;
        const float OrthoSize = 8f; // 64 px per world unit
        var holder = new GameObject("PlannerCaptureHolder");
        holder.SetActive(false);
        var meta = new List<string>();
        var seen = new HashSet<string>();
        foreach (var entry in list.TypeAndPlacementObject)
        {
            string type = entry.Type.ToString();
            if (!seen.Add(type) || entry.Addr_PlacementObject == null || !entry.Addr_PlacementObject.RuntimeKeyIsValid()) continue;
            var ph = Addressables.LoadAssetAsync<GameObject>(entry.Addr_PlacementObject.RuntimeKey);
            yield return ph;
            string build = ph.Status == AsyncOperationStatus.Succeeded && ph.Result ? ph.Result.GetComponent<PlacementObject>()?.ToBuildAsset : null;
            if (string.IsNullOrEmpty(build)) continue;
            string key = build.StartsWith("Assets/") ? build : "Assets/" + build + ".prefab"; // as PlacementObject loads it
            var bh = Addressables.LoadAssetAsync<GameObject>(key);
            yield return bh;
            if (bh.Status != AsyncOperationStatus.Succeeded || !bh.Result) { Logger.LogWarning($"{type}: can't load {key}"); continue; }

            GameObject go = null;
            try
            {
                go = Instantiate(bh.Result, holder.transform, false); // inactive parent: none of its scripts run yet
                StripToVisuals(go, Layer);
                go.transform.SetParent(null, false);
                go.transform.SetPositionAndRotation(anchor, Quaternion.identity);
            }
            catch (Exception e) { Logger.LogError($"{type}: {e}"); if (go) Destroy(go); continue; }
            yield return null;
            yield return null; // Spine builds its mesh in LateUpdate
            yield return new WaitForEndOfFrame();
            try
            {
                var black = Render(cam, Size, Size, OrthoSize, anchor, 1 << Layer, Color.black, post: false, alpha: true);
                var white = Render(cam, Size, Size, OrthoSize, anchor, 1 << Layer, Color.white, post: false, alpha: true);
                string row = SaveCutout(black, white, Path.Combine(dir, type + ".png"));
                Destroy(black);
                Destroy(white);
                if (row != null) meta.Add($"{Json(type)}:{row}");
            }
            catch (Exception e) { Logger.LogError($"{type}: {e}"); }
            Destroy(go);
        }
        Destroy(holder);
        File.WriteAllText(Path.Combine(dir, "buildings.json"),
            $"{{\"ppu\":{Size / (2 * OrthoSize)},\"items\":{{\n{string.Join(",\n", meta)}\n}}}}");
        Logger.LogInfo($"buildings: {meta.Count} rendered");

        // Same ground spot with and without post-processing, to check building colours against the background.
        Try("colour reference", () =>
        {
            foreach (bool post in new[] { true, false })
            {
                var tex = Render(cam, Size, Size, OrthoSize, anchor, cam.cullingMask, Color.black, post, alpha: false);
                File.WriteAllBytes(Path.Combine(dir, post ? "_ref_post.png" : "_ref_nopost.png"), tex.EncodeToPNG());
                Destroy(tex);
            }
        });
    }

    // Gameplay scripts expect brains, save data and managers; Spine renderers are all a building needs to draw.
    // Also off: light sprites (they feed the lighting system, drawn alone they're white blobs), range
    // indicators and other UI, effects, and anything whose shader failed to load (magenta).
    static void StripToVisuals(GameObject go, int layer)
    {
        for (int pass = 0; pass < 3; pass++) // components that others require only go once those are gone
            foreach (var mb in go.GetComponentsInChildren<MonoBehaviour>(true))
                if (mb && !(mb.GetType().Namespace ?? "").StartsWith("Spine")) DestroyImmediate(mb);
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            string sortLayer = r.sortingLayerName, obj = r.gameObject.name.ToLowerInvariant();
            string sprite = (r as SpriteRenderer)?.sprite ? ((SpriteRenderer)r).sprite.name.ToLowerInvariant() : "";
            bool brokenShader = r.sharedMaterials.Any(m => !m || !m.shader || m.shader.name.Contains("InternalError"));
            if (r is ParticleSystemRenderer || brokenShader
                || sortLayer == "Lighting" || sortLayer == "VFX" || sortLayer == "DepthFX" || sortLayer.Contains("UI")
                || sprite.Contains("light") || sprite.Contains("glow") || obj.Contains("light") || obj.Contains("glow")
                || obj.Contains("range") || obj.Contains("radius") || obj.Contains("indicator"))
                r.enabled = false;
        }
        foreach (var t in go.GetComponentsInChildren<Transform>(true)) t.gameObject.layer = layer;
    }

    // Exact cutout from renders over black and over white: alpha = 1 - (white - black), colour = black / alpha.
    // Returns "[anchorX, anchorY, w, h]" with the anchor (render centre) measured from the crop's top-left.
    static string SaveCutout(Texture2D black, Texture2D white, string path)
    {
        int w = black.width, h = black.height;
        var b = black.GetPixels32();
        var wt = white.GetPixels32();
        var o = new Color32[b.Length];
        int x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (int i = 0; i < b.Length; i++)
        {
            int diff = (wt[i].r - b[i].r + wt[i].g - b[i].g + wt[i].b - b[i].b) / 3;
            int a = 255 - Mathf.Clamp(diff, 0, 255);
            if (a < 6) continue;
            o[i] = new Color32((byte)Mathf.Min(255, b[i].r * 255 / a), (byte)Mathf.Min(255, b[i].g * 255 / a), (byte)Mathf.Min(255, b[i].b * 255 / a), (byte)a);
            int x = i % w, y = i / w;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        if (x1 < 0) return null;
        int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        var crop = new Color32[cw * ch];
        for (int y = 0; y < ch; y++) Array.Copy(o, (y0 + y) * w + x0, crop, y * cw, cw);
        var tex = new Texture2D(cw, ch, TextureFormat.RGBA32, false);
        tex.SetPixels32(crop);
        tex.Apply();
        File.WriteAllBytes(path, tex.EncodeToPNG());
        Destroy(tex);
        return $"[{w / 2f - x0:0.#},{y1 + 1 - h / 2f:0.#},{cw},{ch}]"; // Texture2D rows run bottom-up, PNG rows top-down
    }

    // ---------- backgrounds and grid ----------

    IEnumerator CaptureLands()
    {
        var lands = DLCLandController.Instance;
        var region = PlacementRegion.Instance;
        var grids = new List<string>();
        foreach (int level in lands ? new[] { -1, 0, 1, 2 } : new[] { -1 })
        {
            if (lands) { if (level < 0) lands.SetDefault(); else lands.DEBUG_ShowSlot(level); } // in memory only; saving is off
            yield return new WaitForSecondsRealtime(3f);
            yield return new WaitForEndOfFrame();
            Try($"land{level + 1}", () => Shoot($"land{level + 1}", clean: true));
            if (!region) continue;

            var squares = new List<GameObject>();
            Try($"grid{level + 1}", () =>
            {
                if (level < 0)
                {
                    // with nothing bought, CombineColliders leaves the last merge in place; restore the base outline
                    var cached = Traverse.Create(region).Field("cachedColliderPoints").GetValue<Vector2[]>();
                    region.polygonCollider2D.pathCount = 1;
                    region.polygonCollider2D.SetPath(0, cached);
                }
                region.CreateFloodFill();
                var tiles = region.Grid.ToList();
                grids.Add("[" + string.Join(",", tiles.Select(t => $"[{t.Position.x},{t.Position.y},{(t.Occupied ? 1 : 0)}]")) + "]");
                foreach (var t in tiles)
                {
                    var sq = Instantiate(region.PlacementSquare, region.transform, false);
                    sq.transform.localPosition = new Vector3(t.Position.x, t.Position.y, 0f);
                    squares.Add(sq);
                }
                Logger.LogInfo($"land level {level + 1}: {tiles.Count} grid cells, {tiles.Count(t => t.Occupied)} occupied");
            });
            yield return new WaitForSecondsRealtime(1.5f);
            yield return new WaitForEndOfFrame();
            Try($"grid{level + 1}.png", () => Shoot($"grid{level + 1}", clean: true, hideWorldUI: false)); // build tiles draw on a UI sorting layer
            foreach (var sq in squares) Destroy(sq);
        }
        Try("grid.json", () => File.WriteAllText(Path.Combine(outDir, "grid.json"), "[" + string.Join(",", grids) + "]"));
    }

    void Shoot(string name, bool clean, bool hideWorldUI = true)
    {
        var hiddenRenderers = new List<Renderer>();
        var hiddenCanvases = new List<Canvas>();
        void Hide(Component root)
        {
            if (!root) return;
            foreach (var r in root.GetComponentsInChildren<Renderer>(true))
                if (r.enabled) { r.enabled = false; hiddenRenderers.Add(r); }
        }
        foreach (var c in FindObjectsOfType<Canvas>()) if (c.enabled) { c.enabled = false; hiddenCanvases.Add(c); }
        if (hideWorldUI)
            foreach (var r in FindObjectsOfType<SpriteRenderer>())
                if (r.enabled && r.sortingLayerName.Contains("UI")) { r.enabled = false; hiddenRenderers.Add(r); } // world-space bars and icons
        foreach (var p in PlayerFarming.players) Hide(p);
        if (clean)
        {
            foreach (var f in FindObjectsOfType<Follower>()) Hide(f);
            foreach (var s in FindObjectsOfType<Structure>()) if (!Keep.Contains(s.Type.ToString())) Hide(s);
            foreach (var ps in FindObjectsOfType<ParticleSystemRenderer>()) if (ps.enabled) { ps.enabled = false; hiddenRenderers.Add(ps); } // fireflies, dust, weather
        }

        // Screen effects that make no sense on a map: focus blur (the camera is far from its usual
        // focus distance), vignette, grain, fringing, motion blur. Colour grading and bloom stay.
        var switchedOff = new List<PostProcessEffectSettings>();
        foreach (var vol in FindObjectsOfType<PostProcessVolume>())
        {
            var profile = vol.HasInstantiatedProfile() ? vol.profile : vol.sharedProfile;
            if (profile == null) continue;
            foreach (var fx in profile.settings)
                if (fx.active && (fx is DepthOfField || fx is Vignette || fx is Grain || fx is ChromaticAberration || fx is MotionBlur || fx is LensDistortion))
                { fx.active = false; switchedOff.Add(fx); }
        }
        try
        {
            var cam = GameCamera();
            int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
            // centre of the box on the ground (z = 0): u = x, v = K * y
            var centre = new Vector3((U0 + U1) / 2f, (V0 + V1) / 2f / K, 0f);
            var tex = Render(cam, w, h, (V1 - V0) / 2f, centre, cam.cullingMask, Color.black, post: true, alpha: false);
            File.WriteAllBytes(Path.Combine(outDir, name + ".png"), tex.EncodeToPNG());
            Destroy(tex);
            Logger.LogInfo($"wrote {name}.png {w}x{h}, hid {hiddenRenderers.Count} renderers, switched off {switchedOff.Count} screen effects");
        }
        finally
        {
            foreach (var r in hiddenRenderers) if (r) r.enabled = true;
            foreach (var c in hiddenCanvases) if (c) c.enabled = true;
            foreach (var fx in switchedOff) if (fx) fx.active = true;
        }
    }

    static Camera GameCamera()
    {
        var follow = CameraFollowTarget.Instance;
        return follow ? (follow.GetComponent<Camera>() ?? follow.GetComponentInChildren<Camera>()) : Camera.main;
    }

    // One frame from the game camera looking down at 45° without perspective, centred on a ground
    // point. Rendering only some layers clears to `background`; post = false skips post-processing.
    static Texture2D Render(Camera cam, int w, int h, float orthoSize, Vector3 centre, int mask, Color background, bool post, bool alpha)
    {
        var follow = CameraFollowTarget.Instance;
        bool followWas = follow && follow.enabled;
        var t = cam.transform;
        Vector3 pos = t.position;
        Quaternion rot = t.rotation;
        bool ortho = cam.orthographic;
        float size = cam.orthographicSize, near = cam.nearClipPlane, far = cam.farClipPlane;
        int oldMask = cam.cullingMask;
        var oldClear = cam.clearFlags;
        var oldBackground = cam.backgroundColor;
        var target = cam.targetTexture;
        var postLayer = cam.GetComponent<PostProcessLayer>();
        bool postWas = postLayer && postLayer.enabled;
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        try
        {
            if (follow) follow.enabled = false;
            t.rotation = Quaternion.Euler(-45f, 0f, 0f); // forward (0, .707, .707), up (0, .707, -.707): v = K (y - z)
            t.position = centre - t.forward * 80f;
            cam.orthographic = true;
            cam.orthographicSize = orthoSize;
            cam.nearClipPlane = 1f;
            cam.farClipPlane = 300f;
            cam.cullingMask = mask;
            if (mask != oldMask) { cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = background; }
            if (postLayer && !post) postLayer.enabled = false;
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(w, h, alpha ? TextureFormat.RGBA32 : TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            tex.Apply();
            return tex;
        }
        finally
        {
            RenderTexture.active = null;
            cam.targetTexture = target;
            rt.Release();
            t.position = pos;
            t.rotation = rot;
            cam.orthographic = ortho;
            cam.orthographicSize = size;
            cam.nearClipPlane = near;
            cam.farClipPlane = far;
            cam.cullingMask = oldMask;
            cam.clearFlags = oldClear;
            cam.backgroundColor = oldBackground;
            if (postLayer) postLayer.enabled = postWas;
            if (follow) follow.enabled = followWas;
        }
    }
}
