// BepInEx 5 plugin: renders the cult base with the game's own camera, lighting and shaders,
// looking down at 45° without perspective (the planner's projection), and dumps game data.
//
// Flow: on the main menu it continues the configured save slot, waits for the base to settle,
// switches saving off, then runs the enabled jobs:
//   Structures   structures.json: every placed structure's type, cell, footprint and flags
//   Translations i18n.json: every localisation term in every language the game ships
//   Buildings    buildings/<TYPE>.png: each buildable structure alone, as the game draws it,
//                cut out exactly from renders over black and white; buildings/buildings.json
//                holds each sprite's anchor (the centre of the footprint's first cell), and
//                <TYPE>#<i>.png the frames of its idle animation; lights/ the light it casts
//                (mask-<TYPE>.png) and adds (glow-<TYPE>.png); buildings-lit/ graded as in lamp light
//   Backgrounds  landN.png per Woolhaven land level (none bought .. all three, switched in memory
//                with DLCLandController), the game's grid per level in grid.json, and gridN.png
//                with the game's build-mode tile on every cell
// With Looks set (day, dusk, night, rain, winter, blizzard, bloodmoon), Buildings and Backgrounds run
// once per look, each into its own folder, after switching the game to it in memory: the clock, the
// season, the weather and the blood moon lighting. Each look also gets lut.png, the game's colour
// grading for it, which the building renders (made without post-processing) are passed through, and
// lut-lit.png, its grading inside lamp light; where that differs, lit/landN.png too.
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
using Lamb.UI;
using I2.Loc;
using MMTools;
using src.Managers;
using UnityEngine;
using UnityEngine.AddressableAssets;
using UnityEngine.Rendering;
using UnityEngine.Rendering.PostProcessing;
using UnityEngine.ResourceManagement.AsyncOperations;
using UnityEngine.SceneManagement;

[BepInPlugin("chrsnv.cotlplanner.capture", "COTL Planner Capture", "1.2.0")]
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
    ConfigEntry<float> settle, ppu;
    ConfigEntry<string> looks, types;
    ConfigEntry<bool> autoLoad, forceDay, quitAfter, doStructures, doTranslations, doBuildings, doBackgrounds, doDensity;
    string outDir;
    bool started, done;

    void Awake()
    {
        slot = Config.Bind("Capture", "SaveSlot", 0, "Save slot to continue from the main menu.");
        width = Config.Bind("Capture", "Width", 6144, "Background width in pixels (height follows the area's aspect).");
        settle = Config.Bind("Capture", "SettleSeconds", 25f, "Seconds to wait in the base before capturing.");
        ppu = Config.Bind("Capture", "Ppu", 200f, "Pixels per world unit for the buildings, their lights and the backdrop tiles (the game's art has about 200: Density job).");
        autoLoad = Config.Bind("Capture", "AutoLoad", true, "Continue the save automatically from the main menu.");
        forceDay = Config.Bind("Capture", "ForceDay", true, "Move the clock to the afternoon before capturing.");
        quitAfter = Config.Bind("Capture", "QuitAfter", true, "Quit the game after capturing.");
        doStructures = Config.Bind("Jobs", "Structures", true, "structures.json: placed structures with their cells.");
        doDensity = Config.Bind("Jobs", "Density", false, "density.txt: how many texture pixels the game's art has per world unit.");
        doTranslations = Config.Bind("Jobs", "Translations", true, "i18n.json: every localisation term in every language.");
        doBuildings = Config.Bind("Jobs", "Buildings", true, "buildings/: every buildable structure rendered alone.");
        doBackgrounds = Config.Bind("Jobs", "Backgrounds", true, "landN.png, grid.json, gridN.png per land level.");
        types = Config.Bind("Jobs", "Types", "", "Comma-separated structure types to render in Buildings (empty: all).");
        looks = Config.Bind("Jobs", "Looks", "", "Comma-separated looks to run Buildings and Backgrounds in, each into its own folder: day, dusk, night, rain, winter, blizzard, bloodmoon. Empty: once, as the save looks.");
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
        // The game as designed: performance mode draws the lamps' light without depth (so it misses the
        // ground) and stops some animations. Switched off in memory only.
        PerformanceModeManager.PerformanceModeChanged(false);
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
        TimeManager.PauseGameTime = true; // the light only changes when a look asks for it
        if (forceDay.Value)
        {
            TimeManager.CurrentGameTime = 560f; // mid-afternoon: phases are 240 units, afternoon starts at 480
            yield return new WaitForSecondsRealtime(6f);
        }
        if (doDensity.Value) yield return Density();
        if (doStructures.Value) Try("structures", DumpStructures);
        if (doTranslations.Value) Try("translations", DumpTranslations);
        // Snow shows trails from two render textures the game fills around its camera and the player. Past their
        // edge it samples the edge, so a footprint there runs on as a stripe across the backdrop. Black is their
        // cleared state: untrodden snow.
        Shader.SetGlobalTexture("_CameraTrackedFloorRT", SolidMask(Color.black));
        Shader.SetGlobalTexture("_SnowRT", SolidMask(Color.black));
        // The game's clock only moves forward through a day's phases, so afternoon looks go first, then dusk, then night.
        var list = looks.Value.Split(',').Select(l => l.Trim().ToLowerInvariant()).Where(l => l != "")
            .OrderBy(l => l == "dusk" ? 1 : l == "night" ? 2 : 0).ToList();
        if (list.Count == 0)
        {
            if (doBuildings.Value) yield return CaptureBuildings(outDir, null, null, false);
            if (doBackgrounds.Value) yield return CaptureLands(outDir, true, false);
        }
        foreach (var look in list)
        {
            string dir = Path.Combine(outDir, look);
            Directory.CreateDirectory(dir);
            yield return SetLook(look);
            Color32[] lut = null, lit = null;
            Try($"{look} lut", () => lut = GradingLut(Path.Combine(dir, "lut.png")));
            Try($"{look} lit lut", () => lit = GradingLut(Path.Combine(dir, "lut-lit.png"), SolidMask(Color.white)));
            // Inside a lamp's light the game grades with a second LUT; where it barely differs, lamps don't show.
            double litBy = lut != null && lit != null ? lut.Zip(lit, (p, q) => Math.Abs(p.r - q.r) + Math.Abs(p.g - q.g) + Math.Abs(p.b - q.b)).Average() / 3 : 0;
            Logger.LogInfo($"{look}: the lit grading differs by {litBy:0.0} on average");
            if (litBy < LitThreshold) lit = null;
            if (doBuildings.Value) yield return CaptureBuildings(dir, lut, lit, look == "winter" || look == "blizzard");
            if (doBackgrounds.Value) yield return CaptureLands(dir, look == list[0], lit != null);
        }
        Try("capture.json", () =>
        {
            int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
            float p = ppu.Value;
            int W = Mathf.CeilToInt((U1 - U0) * p), H = Mathf.CeilToInt((V1 - V0) * p);
            File.WriteAllText(Path.Combine(outDir, "capture.json"),
                $"{{\"ppu\":{w / (U1 - U0):0.####},\"w\":{w},\"h\":{h},\"u_left\":{U0},\"v_top\":{V1},\"time\":\"{DateTime.Now:s}\"," +
                $"\"tiles\":{{\"ppu\":{p},\"w\":{W},\"h\":{H},\"tile\":[{TileW},{TileH}],\"border\":{Border},\"cols\":{(W + TileW - 1) / TileW},\"rows\":{(H + TileH - 1) / TileH}}}}}");
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

    // ---------- the art's resolution ----------

    // Texture pixels per world unit of the buildings' sprites (pixels per unit over their scale) and Spine
    // parts (1 / skeleton scale over their scale), and of the base's own scenery: what a capture needs to
    // keep every pixel of the art.
    IEnumerator Density()
    {
        var log = new StringBuilder();
        string Stats(List<float> v)
        {
            if (v.Count == 0) return "none";
            v.Sort();
            float At(float q) => v[Math.Min(v.Count - 1, (int)(q * v.Count))];
            return $"{v.Count} parts: p10 {At(.1f):0} p50 {At(.5f):0} p90 {At(.9f):0} p99 {At(.99f):0} max {v[v.Count - 1]:0}";
        }
        float Sprite(SpriteRenderer r) => r.sprite.pixelsPerUnit / Mathf.Max(1e-4f, Mathf.Max(Mathf.Abs(r.transform.lossyScale.x), Mathf.Abs(r.transform.lossyScale.y)));
        float Spine(Spine.Unity.SkeletonAnimation a) => 1f / Mathf.Max(1e-6f, a.skeletonDataAsset.scale * Mathf.Max(Mathf.Abs(a.transform.lossyScale.x), Mathf.Abs(a.transform.lossyScale.y)));
        var sprites = new List<float>(); var spines = new List<float>(); var perType = new List<string>();
        var list = FindObjectOfType<TypeAndPlacementObjects>();
        var holder = new GameObject("PlannerCaptureDensity");
        holder.SetActive(false);
        var seen = new HashSet<string>();
        foreach (var entry in list ? list.TypeAndPlacementObject : new List<TypeAndPlacementObject>())
        {
            if (!seen.Add(entry.Type.ToString()) || entry.Addr_PlacementObject == null || !entry.Addr_PlacementObject.RuntimeKeyIsValid()) continue;
            GameObject go = null;
            yield return Place(entry, holder, new Vector3(0, 0, 0), false, g => go = g);
            if (!go) continue;
            Try($"{entry.Type} density", () =>
            {
                var mine = go.GetComponentsInChildren<SpriteRenderer>().Where(r => r.enabled && r.sprite && r.gameObject.layer == Body).Select(Sprite).ToList();
                var bones = go.GetComponentsInChildren<Spine.Unity.SkeletonAnimation>().Where(a => a.skeletonDataAsset).Select(Spine).ToList();
                sprites.AddRange(mine); spines.AddRange(bones);
                if (mine.Count + bones.Count > 0) perType.Add($"{entry.Type}: sprites [{string.Join(" ", mine.Select(x => x.ToString("0")))}] spine [{string.Join(" ", bones.Select(x => x.ToString("0")))}]");
            });
            Destroy(go);
        }
        Destroy(holder);
        var ground = FindObjectsOfType<SpriteRenderer>().Where(r => r.enabled && r.sprite && !r.GetComponentInParent<Structure>() && !r.GetComponentInParent<Follower>()).Select(Sprite).ToList();
        log.AppendLine($"building sprites: {Stats(sprites)}");
        log.AppendLine($"building spine: {Stats(spines)}");
        log.AppendLine($"base scenery sprites: {Stats(ground)}");
        log.AppendLine($"capture now: buildings 64, backdrop {width.Value / (U1 - U0):0} px per unit");
        log.AppendLine().AppendLine(string.Join("\n", perType));
        File.WriteAllText(Path.Combine(outDir, "density.txt"), log.ToString());
        Logger.LogInfo("density.txt written");
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

    const double LitThreshold = 2; // mean difference between the LUTs below which a look gets no lamp light
    const int Body = 31, Glow = 30, LightLayer = 20; // LightLayer: what the lighting camera draws into the mask
    const int AnimMaxFrames = 24;

    // `lut`: the look's colour grading (null: none); `lit`: its grading inside lamp light (null: lamps don't
    // show in this look). `winter`: show the parts buildings only have in winter.
    // Writes per building, each with its anchor in buildings.json:
    //   buildings/<TYPE>.png       the building as the game draws it (and buildings-lit/ graded with `lit`)
    //   buildings/<TYPE>#<i>.png   a loop of its idle animation, if it has one; anim[TYPE] = [frames, fps]
    //   lights/mask-<TYPE>.png     with `lit`: the light it casts into the game's mask (white, alpha = mask)
    //   lights/glow-<TYPE>.png     its additive light (halos, light shafts), to add on top
    IEnumerator CaptureBuildings(string root, Color32[] lut, Color32[] lit, bool winter)
    {
        var list = FindObjectOfType<TypeAndPlacementObjects>();
        var region = PlacementRegion.Instance;
        if (!list || !region) { Logger.LogWarning("no build list or placement region in the scene"); yield break; }
        string dir = Path.Combine(root, "buildings"), litDir = Path.Combine(root, "buildings-lit"), lightDir = Path.Combine(root, "lights");
        Directory.CreateDirectory(dir);
        Directory.CreateDirectory(lightDir);
        if (lit != null) Directory.CreateDirectory(litDir);
        var cam = GameCamera();
        // The game puts a building's prefab, unrotated, at the centre of its footprint's first cell.
        // Cell (0,0) is open ground in the base, so the building gets the base's lighting there.
        Vector3 anchor = region.transform.TransformPoint(Vector3.zero);
        // The game's camera is pointed at it for the whole pass, as it frames the player, and shows the
        // capture layers: this game's Spine only animates skeletons its camera shows. Nobody watches the screen.
        var follow = CameraFollowTarget.Instance;
        bool followWas = follow && follow.enabled;
        var rig = follow ? follow.transform : cam.transform; // the camera itself sits below the rig the game moves
        Vector3 rigPos = rig.position;
        int camMask = cam.cullingMask;
        if (follow) follow.enabled = false;
        rig.position += anchor - GroundHit(cam.transform.position, cam.transform.forward);
        cam.cullingMask |= 1 << Body | 1 << Glow;
        yield return null;
        yield return new WaitForEndOfFrame();
        Logger.LogInfo($"camera aimed at {GroundHit(cam.transform.position, cam.transform.forward)} for {anchor}; it shows that at {cam.WorldToScreenPoint(anchor)} of {cam.pixelWidth}x{cam.pixelHeight}");
        const float OrthoSize = 8f; // a 16-unit square holds the biggest building
        int Size = Mathf.RoundToInt(2 * OrthoSize * ppu.Value), MaskSize = 2 * Size; // light reaches further
        var holder = new GameObject("PlannerCaptureHolder");
        holder.SetActive(false);
        var meta = new List<string>();
        var anims = new List<string>();
        var lights = new List<string>();
        var seen = new HashSet<string>();
        var only = new HashSet<string>(types.Value.Split(',').Select(t => t.Trim()).Where(t => t != ""));
        foreach (var entry in list.TypeAndPlacementObject)
        {
            string type = entry.Type.ToString();
            if (only.Count > 0 && !only.Contains(type)) continue;
            if (!seen.Add(type) || entry.Addr_PlacementObject == null || !entry.Addr_PlacementObject.RuntimeKeyIsValid()) continue;
            GameObject go = null;
            yield return Place(entry, holder, anchor, winter, g => go = g);
            if (!go) continue;
            yield return null;
            yield return null; // Spine builds its mesh in LateUpdate
            yield return new WaitForEndOfFrame();
            string Shot(string name, Color32[] grade, Color32[] gradeLit)
            {
                var black = Render(cam, Size, Size, OrthoSize, anchor, 1 << Body, Color.black, post: false, alpha: true);
                var white = Render(cam, Size, Size, OrthoSize, anchor, 1 << Body, Color.white, post: false, alpha: true);
                var px = Cutout(black.GetPixels32(), white.GetPixels32());
                Destroy(black);
                Destroy(white);
                if (gradeLit != null) SaveCrop(px, Size, Size, Path.Combine(litDir, name + ".png"), c => Grade(gradeLit, c));
                return SaveCrop(px, Size, Size, Path.Combine(dir, name + ".png"), c => grade == null ? c : Grade(grade, c));
            }
            string row = null;
            Try(type, () => { row = Shot(type, lut, lit); if (row != null) meta.Add($"{Json(type)}:{row}"); });
            if (row == null) { Destroy(go); continue; }

            // additive light parts, rendered alone over black: graded as the light adds to what's under it
            Try($"{type} glow", () =>
            {
                if (!go.GetComponentsInChildren<Renderer>().Any(r => r.gameObject.layer == Glow && r.enabled)) return;
                var tex = Render(cam, Size, Size, OrthoSize, anchor, 1 << Glow, Color.black, post: false, alpha: false);
                var g = lit ?? lut;
                Color32 zero = g == null ? new Color32(0, 0, 0, 255) : Grade(g, new Color32(0, 0, 0, 255));
                var px = tex.GetPixels32().Select(c => c.r + c.g + c.b > 6 ? c : new Color32(0, 0, 0, 0)).ToArray();
                Destroy(tex);
                string glow = SaveCrop(px, Size, Size, Path.Combine(lightDir, $"glow-{type}.png"), c =>
                {
                    if (g == null) return c;
                    var d = Grade(g, c);
                    return new Color32((byte)Math.Max(0, d.r - zero.r), (byte)Math.Max(0, d.g - zero.g), (byte)Math.Max(0, d.b - zero.b), 255);
                });
                if (glow != null) lights.Add($"{Json("glow:" + type)}:{glow}");
            });

            // The light it casts on the ground: the light mask with every other light off, and everything
            // standing up out of the way, which would catch the light before the ground does (up is -z).
            if (lit != null && go.GetComponentsInChildren<Renderer>().Any(r => r.gameObject.layer == LightLayer && r.enabled))
                Try($"{type} light", () =>
                {
                    bool mine(Renderer r) => r.transform.IsChildOf(go.transform);
                    bool standing(Renderer r) => r.bounds.min.z < -.3f && r.bounds.size.x < 30 && r.bounds.size.y < 30; // not the ground itself
                    var others = FindObjectsOfType<Renderer>().Where(r => r.enabled && (r.gameObject.layer == LightLayer ? !mine(r) : standing(r))).ToList();
                    foreach (var r in others) r.enabled = false;
                    try
                    {
                        var rt = LightMask(cam, MaskSize, MaskSize, 2 * OrthoSize, anchor, cam.cullingMask);
                        var was = RenderTexture.active;
                        RenderTexture.active = rt;
                        var tex = new Texture2D(MaskSize, MaskSize, TextureFormat.RGBA32, false);
                        tex.ReadPixels(new Rect(0, 0, MaskSize, MaskSize), 0, 0);
                        RenderTexture.active = was;
                        rt.Release();
                        var px = tex.GetPixels32().Select(c => new Color32(255, 255, 255, c.r)).ToArray();
                        Destroy(tex);
                        string mask = SaveCrop(px, MaskSize, MaskSize, Path.Combine(lightDir, $"mask-{type}.png"), c => c);
                        if (mask != null) lights.Add($"{Json("mask:" + type)}:{mask}");
                    }
                    finally { foreach (var r in others) if (r) r.enabled = true; }
                });

            // An idle animation: one loop of its longest part, stepped through the game's own clock so that
            // Spine, Animator and shader-driven motion (flags) all move together.
            float loop = LoopLength(go);
            if (loop > 0)
            {
                int frames = Mathf.Clamp(Mathf.RoundToInt(loop * 24), 4, AnimMaxFrames);
                var rows = new List<string>();
                var first = new Color32[0];
                int moved = 0;
                float step = loop / frames;
                foreach (var an in go.GetComponentsInChildren<Animator>()) an.cullingMode = AnimatorCullingMode.AlwaysAnimate;
                Time.captureDeltaTime = step; // every frame now moves the game's clock by one step
                for (int i = 0; i < frames; i++)
                {
                    Unpause(type); // a menu opening mid-loop would freeze the rest of it
                    yield return null;
                    yield return new WaitForEndOfFrame();
                    Try($"{type} frame {i}", () =>
                    {
                        var black = Render(cam, Size, Size, OrthoSize, anchor, 1 << Body, Color.black, post: false, alpha: true);
                        var white = Render(cam, Size, Size, OrthoSize, anchor, 1 << Body, Color.white, post: false, alpha: true);
                        var px = Cutout(black.GetPixels32(), white.GetPixels32());
                        Destroy(black);
                        Destroy(white);
                        if (i == 0) first = px;
                        else
                        {
                            int differ = 0;
                            for (int k = 0; k < px.Length; k++) if (px[k].a != first[k].a || px[k].r != first[k].r || px[k].g != first[k].g || px[k].b != first[k].b) differ++;
                            moved = Math.Max(moved, differ);
                        }
                        if (lit != null) SaveCrop(px, Size, Size, Path.Combine(litDir, $"{type}#{i}.png"), c => Grade(lit, c));
                        rows.Add($"{Json($"{type}#{i}")}:{SaveCrop(px, Size, Size, Path.Combine(dir, $"{type}#{i}.png"), c => lut == null ? c : Grade(lut, c))}");
                    });
                    if (i == 3 && moved == 0) break; // a pose, not an animation
                }
                Time.captureDeltaTime = 0;
                if (moved >= 40 && rows.Count == frames)
                {
                    meta.AddRange(rows);
                    anims.Add($"{Json(type)}:[{frames},{frames / loop:0.###}]");
                }
                else foreach (var f in Enumerable.Range(0, frames)) { File.Delete(Path.Combine(dir, $"{type}#{f}.png")); File.Delete(Path.Combine(litDir, $"{type}#{f}.png")); }
                Logger.LogInfo($"{type}: loop {loop:0.##}s, {frames} frames, {moved} pixels move{(moved < 40 ? ": static" : "")}");
            }
            Destroy(go);
        }
        Destroy(holder);
        cam.cullingMask = camMask;
        rig.position = rigPos;
        if (follow) follow.enabled = followWas;
        File.WriteAllText(Path.Combine(dir, "buildings.json"),
            $"{{\"ppu\":{Size / (2 * OrthoSize)},\"anim\":{{{string.Join(",", anims)}}},\"items\":{{\n{string.Join(",\n", meta)}\n}}}}");
        File.WriteAllText(Path.Combine(lightDir, "lights.json"),
            $"{{\"ppu\":{Size / (2 * OrthoSize)},\"items\":{{\n{string.Join(",\n", lights)}\n}}}}");
        Logger.LogInfo($"buildings: {meta.Count} rendered, {anims.Count} animated, {lights.Count} lights and glows");
    }

    // A building's prefab as the build menu places it, stripped to what it draws, standing at `at`.
    IEnumerator Place(TypeAndPlacementObject entry, GameObject holder, Vector3 at, bool winter, Action<GameObject> got)
    {
        string type = entry.Type.ToString();
        var ph = Addressables.LoadAssetAsync<GameObject>(entry.Addr_PlacementObject.RuntimeKey);
        yield return ph;
        string build = ph.Status == AsyncOperationStatus.Succeeded && ph.Result ? ph.Result.GetComponent<PlacementObject>()?.ToBuildAsset : null;
        if (string.IsNullOrEmpty(build)) yield break;
        string key = build.StartsWith("Assets/") ? build : "Assets/" + build + ".prefab"; // as PlacementObject loads it
        var bh = Addressables.LoadAssetAsync<GameObject>(key);
        yield return bh;
        if (bh.Status != AsyncOperationStatus.Succeeded || !bh.Result) { Logger.LogWarning($"{type}: can't load {key}"); yield break; }
        GameObject go = null;
        try
        {
            go = Instantiate(bh.Result, holder.transform, false); // inactive parent: none of its scripts run yet
            StripScripts(go, winter);
            go.transform.SetParent(null, false); // the light scripts set their meshes up now
            go.transform.SetPositionAndRotation(at, Quaternion.identity);
            SortRenderers(go);
            got(go);
        }
        catch (Exception e) { Logger.LogError($"{type}: {e}"); if (go) Destroy(go); }
    }

    // Where a ray meets the ground (z = 0).
    static Vector3 GroundHit(Vector3 from, Vector3 dir) => from - dir * (from.z / dir.z);

    // The longest loop among a building's animated parts (seconds; 0: nothing moves): Spine tracks and
    // Animator states at their playback speed, and 2 s for sprites the shader moves (flags in the wind).
    static float LoopLength(GameObject go)
    {
        float loop = 0;
        foreach (var a in go.GetComponentsInChildren<Spine.Unity.SkeletonAnimation>())
        {
            var track = a.AnimationState?.GetCurrent(0);
            float speed = a.timeScale * (a.AnimationState?.TimeScale ?? 1) * (track?.TimeScale ?? 1);
            if (track?.Animation != null && track.Loop && speed > 0 && track.Animation.Duration > 0) loop = Mathf.Max(loop, track.Animation.Duration / speed);
        }
        foreach (var an in go.GetComponentsInChildren<Animator>())
        {
            if (!an.runtimeAnimatorController || an.speed <= 0) continue;
            foreach (var clip in an.GetCurrentAnimatorClipInfo(0)) if (clip.clip.isLooping) loop = Mathf.Max(loop, clip.clip.length / an.speed);
        }
        if (go.GetComponentsInChildren<Renderer>().Any(r => r.gameObject.layer == Body && r.enabled && r.sharedMaterials.Any(m => m && m.shader && m.shader.name.Contains("Deformer"))))
            loop = Mathf.Max(loop, 2f);
        return loop;
    }

    // Gameplay scripts expect brains, save data and managers; Spine renderers are all a building needs to draw.
    // The light scripts stay: they point their decals and switch their additive parts on as they wake up.
    static void StripScripts(GameObject go, bool winter)
    {
        // Parts that come and go with the season (snow caps, icicles), set the way the game sets them
        // (ActivateOnSeason.CheckState, WinterOnly), before their scripts are stripped. In winter the
        // game shows a share of a structure's snow clumps that grows with severity; all of them here.
        foreach (var a in go.GetComponentsInChildren<ActivateOnSeason>(true))
        {
            bool on = winter ? !a.DisableOnWinter : a.DisableOnWinter;
            var mesh = a.GetComponent<MeshRenderer>();
            var sprite = a.GetComponent<SpriteRenderer>();
            if (a.useRenderer && (mesh || sprite)) { if (mesh) mesh.enabled = on; if (sprite) sprite.enabled = on; }
            else a.gameObject.SetActive(on);
            if (winter) foreach (Transform t in a.transform) t.gameObject.SetActive(true);
        }
        foreach (var w in go.GetComponentsInChildren<WinterOnly>(true))
            foreach (var e in Traverse.Create(w).Field("elements").GetValue<List<GameObject>>() ?? new List<GameObject>())
                if (e) e.SetActive(winter);
        for (int pass = 0; pass < 3; pass++) // components that others require only go once those are gone
            foreach (var mb in go.GetComponentsInChildren<MonoBehaviour>(true))
                if (mb && !(mb is IStencilLighting) && !(mb.GetType().Namespace ?? "").StartsWith("Spine")) DestroyImmediate(mb);
    }

    // Each renderer onto the layer it's captured on: the lighting camera's layer for what feeds the mask,
    // Glow for additive light the camera shows (halos, light shafts), Body for the rest. Off: range
    // indicators and other UI, particles, and anything whose shader failed to load (magenta).
    static void SortRenderers(GameObject go)
    {
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            int layer = r.gameObject.layer;
            string sortLayer = r.sortingLayerName, obj = r.gameObject.name.ToLowerInvariant();
            string shader = r.sharedMaterials.Select(m => m && m.shader ? m.shader.name : "").FirstOrDefault() ?? "";
            bool brokenShader = r.sharedMaterials.Any(m => !m || !m.shader || m.shader.name.Contains("InternalError"));
            if (layer == LightLayer) { if (r is ParticleSystemRenderer || r is SpriteRenderer) r.enabled = false; continue; } // light decals and volumes (sprites there are UI)
            if (shader.Contains("StencilLighting_Volumetric") || shader.Contains("VolumetricLighting") || shader.Contains("Additive")) r.gameObject.layer = Glow;
            else if (r is ParticleSystemRenderer || brokenShader || shader.Contains("StencilLighting") // light decals placed on other layers
                || sortLayer == "Lighting" || sortLayer == "VFX" || sortLayer == "DepthFX" || sortLayer.Contains("UI")
                || obj.Contains("range") || obj.Contains("radius") || obj.Contains("indicator"))
                r.enabled = false;
            else r.gameObject.layer = Body;
        }
    }

    // Exact cutout from renders over black and over white: alpha = 1 - (white - black), colour = black / alpha.
    static Color32[] Cutout(Color32[] b, Color32[] wt)
    {
        var o = new Color32[b.Length];
        for (int i = 0; i < b.Length; i++)
        {
            int diff = (wt[i].r - b[i].r + wt[i].g - b[i].g + wt[i].b - b[i].b) / 3;
            int a = 255 - Mathf.Clamp(diff, 0, 255);
            if (a < 6) continue;
            o[i] = new Color32((byte)Mathf.Min(255, b[i].r * 255 / a), (byte)Mathf.Min(255, b[i].g * 255 / a), (byte)Mathf.Min(255, b[i].b * 255 / a), (byte)a);
        }
        return o;
    }

    // Saves the visible part (alpha > 0) of a w x h render, each pixel through `map`.
    // Returns "[anchorX, anchorY, w, h]" with the anchor (render centre) measured from the crop's top-left.
    static string SaveCrop(Color32[] px, int w, int h, string path, Func<Color32, Color32> map)
    {
        int x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (int i = 0; i < px.Length; i++)
        {
            if (px[i].a == 0) continue;
            int x = i % w, y = i / w;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
        if (x1 < 0) return null;
        int cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        var crop = new Color32[cw * ch];
        for (int y = 0; y < ch; y++)
            for (int x = 0; x < cw; x++)
            {
                var c = px[(y0 + y) * w + x0 + x];
                crop[y * cw + x] = c.a == 0 ? c : map(c);
            }
        var tex = new Texture2D(cw, ch, TextureFormat.RGBA32, false);
        tex.SetPixels32(crop);
        tex.Apply();
        File.WriteAllBytes(path, tex.EncodeToPNG());
        Destroy(tex);
        return $"[{w / 2f - x0:0.#},{y1 + 1 - h / 2f:0.#},{cw},{ch}]"; // Texture2D rows run bottom-up, PNG rows top-down
    }

    // ---------- looks: time of day, season, weather, blood moon ----------

    float? lastHalloween; // the save's own value, put back after the blood moon look

    IEnumerator SetLook(string look)
    {
        bool winter = look == "winter" || look == "blizzard";
        Unpause($"look {look}");
        Try($"look {look}", () =>
        {
            if (winter != (SeasonsManager.CurrentSeason == SeasonsManager.Season.Winter))
            {
                SeasonsManager.ActivateSeasons();
                SeasonsManager.CurrentSeason = winter ? SeasonsManager.Season.Winter : SeasonsManager.Season.Spring;
                // what the game's own season change fires, so season-only scenery follows
                (AccessTools.Field(typeof(SeasonsManager), "OnSeasonChanged").GetValue(null) as SeasonsManager.SeasonEvent)?.Invoke(SeasonsManager.CurrentSeason);
            }
            var weather = WeatherSystemController.Instance;
            if (weather)
            {
                // the game's presets: heavy rain, a winter day's heavy snow, and the blizzard's extreme snow
                if (look == "rain") weather.SetWeather(WeatherSystemController.WeatherType.Raining, WeatherSystemController.WeatherStrength.Heavy, 0f);
                else if (look == "winter") weather.SetWeather(WeatherSystemController.WeatherType.Snowing, WeatherSystemController.WeatherStrength.Heavy, 0f);
                else if (look == "blizzard") weather.SetWeather(WeatherSystemController.WeatherType.Snowing, WeatherSystemController.WeatherStrength.Extreme, 0f);
                else weather.StopCurrentWeather(0f);
            }
            // the base switches the blood moon lighting off again unless the blood moon is really on
            // (FollowerBrainStats.IsBloodMoon: a Halloween ritual less than 3 days ago)
            var location = BaseLocationManager.Instance;
            if (look == "bloodmoon")
            {
                lastHalloween ??= DataManager.Instance.LastHalloween;
                DataManager.Instance.LastHalloween = TimeManager.TotalElapsedGameTime;
                if (location) location.EnableBloodMoon();
            }
            else if (lastHalloween.HasValue)
            {
                DataManager.Instance.LastHalloween = lastHalloween.Value;
                lastHalloween = null;
                if (location) location.DisableBloodMoon();
            }
            TimeManager.CurrentGameTime = look == "dusk" ? 840f : look == "night" ? 1080f : 560f; // phase changes with the clock
        });
        yield return new WaitForSecondsRealtime(3f);
        Unpause($"look {look}"); // the switch itself can bring up a menu
        yield return new WaitForSecondsRealtime(winter || look == "rain" ? 20f : 10f); // lighting and weather ease in
        Logger.LogInfo($"look {look}: season {SeasonsManager.CurrentSeason}, weather {WeatherSystemController.Instance?.CurrentWeatherType}, phase {TimeManager.CurrentPhase}, snow {Shader.GetGlobalFloat("_Snow_Intensity"):0.##}");
    }

    // The look's colour grading (the game's Amplify Color LUTs and exposure) as a 32x32x32 table: an identity
    // colour chart drawn on its own and rendered through the post-processing stack, with the effects that
    // spread light around (bloom, blur) off. Lamps light their surroundings with a second LUT and clouds
    // cast moving shadows, so the chart is small, far from the base's lights, with the cloud overlay off,
    // and taken at five spots: each entry is the median. Saved as `path` too, blue slices 8 per row.
    // `mask`: the light mask to grade through instead of the lamps' (white: everything lit by a lamp).
    Color32[] GradingLut(string path, Texture mask = null)
    {
        var fx = StencilLighting_MaskEffect.Instance;
        if (!mask || !fx || !fx.amplifyPostEffect) return GradingLut(path);
        bool disabled = StencilLighting_MaskEffect.DisableRender;
        var old = fx.amplifyPostEffect.MaskTexture.value;
        StencilLighting_MaskEffect.DisableRender = true; // keeps the mask as set
        var rt = new RenderTexture(4, 4, 0, RenderTextureFormat.Default);
        Graphics.Blit(mask, rt);
        fx.amplifyPostEffect.MaskTexture.Override(rt);
        try { return GradingLut(path); }
        finally { fx.amplifyPostEffect.MaskTexture.value = old; StencilLighting_MaskEffect.DisableRender = disabled; rt.Release(); }
    }

    // A light mask of one colour (the grading reads it as a render texture).
    static RenderTexture SolidMask(Color c)
    {
        var rt = new RenderTexture(4, 4, 0, RenderTextureFormat.Default);
        var was = RenderTexture.active;
        RenderTexture.active = rt;
        GL.Clear(false, true, c);
        RenderTexture.active = was;
        return rt;
    }

    Color32[] GradingLut(string path)
    {
        const int N = 32, W = 8 * N, H = 4 * N, Layer = 31;
        var chart = new Texture2D(W, H, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point, wrapMode = TextureWrapMode.Clamp };
        var px = new Color32[W * H];
        for (int b = 0; b < N; b++)
            for (int g = 0; g < N; g++)
                for (int r = 0; r < N; r++)
                    px[((b / 8) * N + g) * W + (b % 8) * N + r] = new Color32((byte)(r * 255 / 31), (byte)(g * 255 / 31), (byte)(b * 255 / 31), 255);
        chart.SetPixels32(px);
        chart.Apply();
        var go = new GameObject("PlannerCaptureChart") { layer = Layer };
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = Sprite.Create(chart, new Rect(0, 0, W, H), new Vector2(.5f, .5f), 100f); // 2.56 x 1.28 world units
        sr.sharedMaterial = new Material(Shader.Find("Sprites/Default"));
        var origin = PlacementRegion.Instance ? PlacementRegion.Instance.transform.position : Vector3.zero;
        var overlay = ScreenSpaceOverlay.Instance ? ScreenSpaceOverlay.Instance.GetRenderer() : null;
        bool overlayWas = overlay && overlay.enabled;
        if (overlay) overlay.enabled = false;
        var off = ScreenEffectsOff(bloom: true);
        try
        {
            var cam = GameCamera();
            var shots = new List<Color32[]>();
            foreach (var spot in new[] { new Vector3(400, 400), new Vector3(-400, 400), new Vector3(400, -400), new Vector3(-400, -400), new Vector3(0, 600) })
            {
                var at = origin + spot;
                go.transform.SetPositionAndRotation(at, Quaternion.Euler(-45f, 0f, 0f)); // facing the capture camera, texel = pixel
                var shot = Render(cam, W, H, H / 200f, at, 1 << Layer, Color.black, post: true, alpha: false);
                shots.Add(shot.GetPixels32());
                Destroy(shot);
            }
            var graded = new Color32[px.Length];
            int spread = 0;
            for (int i = 0; i < px.Length; i++)
            {
                byte Mid(Func<Color32, byte> ch)
                {
                    var v = shots.Select(sh => ch(sh[i])).OrderBy(x => x).ToList();
                    spread = Math.Max(spread, v[v.Count - 1] - v[0]);
                    return v[v.Count / 2];
                }
                graded[i] = new Color32(Mid(c => c.r), Mid(c => c.g), Mid(c => c.b), 255);
            }
            var outTex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            outTex.SetPixels32(graded);
            File.WriteAllBytes(path, outTex.EncodeToPNG());
            Destroy(outTex);
            // the building renders skip post-processing; anything still grading them would show up here
            var plain = Render(cam, W, H, H / 200f, origin + new Vector3(0, 600), 1 << Layer, Color.black, post: false, alpha: false);
            var raw = plain.GetPixels32();
            Destroy(plain);
            int drift = 0;
            for (int i = 0; i < px.Length; i++) drift = Math.Max(drift, Math.Max(Math.Abs(raw[i].r - px[i].r), Math.Max(Math.Abs(raw[i].g - px[i].g), Math.Abs(raw[i].b - px[i].b))));
            Logger.LogInfo($"{Path.GetFileName(Path.GetDirectoryName(path))} grading: spots differ by {spread} at most, chart without post-processing by {drift}");
            var lut = new Color32[N * N * N];
            for (int b = 0; b < N; b++)
                for (int g = 0; g < N; g++)
                    for (int r = 0; r < N; r++)
                        lut[(b * N + g) * N + r] = graded[((b / 8) * N + g) * W + (b % 8) * N + r];
            return lut;
        }
        finally
        {
            foreach (var fx in off) if (fx) fx.active = true;
            if (overlay) overlay.enabled = overlayWas;
            Destroy(go);
            Destroy(chart);
        }
    }

    // A colour through the grading table, trilinear between its 32 steps per channel; alpha unchanged.
    static Color32 Grade(Color32[] lut, Color32 c)
    {
        const int N = 32;
        float fr = c.r * (N - 1) / 255f, fg = c.g * (N - 1) / 255f, fb = c.b * (N - 1) / 255f;
        int r0 = (int)fr, g0 = (int)fg, b0 = (int)fb;
        int r1 = Math.Min(r0 + 1, N - 1), g1 = Math.Min(g0 + 1, N - 1), b1 = Math.Min(b0 + 1, N - 1);
        float dr = fr - r0, dg = fg - g0, db = fb - b0;
        float Ch(int k)
        {
            float At(int r, int g, int b) { var v = lut[(b * N + g) * N + r]; return k == 0 ? v.r : k == 1 ? v.g : v.b; }
            float x00 = Mathf.Lerp(At(r0, g0, b0), At(r1, g0, b0), dr), x10 = Mathf.Lerp(At(r0, g1, b0), At(r1, g1, b0), dr);
            float x01 = Mathf.Lerp(At(r0, g0, b1), At(r1, g0, b1), dr), x11 = Mathf.Lerp(At(r0, g1, b1), At(r1, g1, b1), dr);
            return Mathf.Lerp(Mathf.Lerp(x00, x10, dg), Mathf.Lerp(x01, x11, dg), db);
        }
        return new Color32((byte)Mathf.RoundToInt(Ch(0)), (byte)Mathf.RoundToInt(Ch(1)), (byte)Mathf.RoundToInt(Ch(2)), c.a);
    }

    // Screen effects that make no sense on a map: focus blur (the camera is far from its usual focus
    // distance), vignette, grain, fringing, motion blur; bloom too for colour charts. Returns what it
    // switched off, to switch back on.
    static List<PostProcessEffectSettings> ScreenEffectsOff(bool bloom = false)
    {
        var off = new List<PostProcessEffectSettings>();
        foreach (var vol in FindObjectsOfType<PostProcessVolume>())
        {
            var profile = vol.HasInstantiatedProfile() ? vol.profile : vol.sharedProfile;
            if (profile == null) continue;
            foreach (var fx in profile.settings)
                if (fx.active && (fx is DepthOfField || fx is Vignette || fx is Grain || fx is ChromaticAberration || fx is MotionBlur || fx is LensDistortion || (bloom && fx is Bloom)))
                { fx.active = false; off.Add(fx); }
        }
        return off;
    }

    // ---------- backgrounds and grid ----------

    // `lit`: also landN.png graded as if all of it stood in lamp light, in lit/, for the planner to show
    // through the light of placed lamps.
    IEnumerator CaptureLands(string dir, bool withGrid, bool lit)
    {
        if (lit) Directory.CreateDirectory(Path.Combine(dir, "lit"));
        var lands = DLCLandController.Instance;
        var region = PlacementRegion.Instance;
        var grids = new List<string>();
        foreach (int level in lands ? new[] { -1, 0, 1, 2 } : new[] { -1 })
        {
            if (lands) { if (level < 0) lands.SetDefault(); else lands.DEBUG_ShowSlot(level); } // in memory only; saving is off
            yield return new WaitForSecondsRealtime(3f);
            yield return new WaitForEndOfFrame();
            Try($"land{level + 1}", () => ShootTiles(Path.Combine(dir, $"land{level + 1}")));
            if (lit) Try($"lit land{level + 1}", () => ShootTiles(Path.Combine(dir, "lit", $"land{level + 1}"), SolidMask(Color.white)));
            if (!region || !withGrid) continue;

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
            Try($"grid{level + 1}.png", () => Shoot(Path.Combine(dir, $"grid{level + 1}.png"), clean: true, hideWorldUI: false)); // build tiles draw on a UI sorting layer
            foreach (var sq in squares) Destroy(sq);
        }
        if (withGrid) Try("grid.json", () => File.WriteAllText(Path.Combine(dir, "grid.json"), "[" + string.Join(",", grids) + "]"));
    }

    // The backdrop at Ppu, in tiles of TileW x TileH (plus a Border of their neighbours' pixels all round,
    // so they join without seams at any zoom), saved as folder/<col>_<row>.png. Each is cut from the middle
    // of a frame the size of the game's own view (about 29.5 x 16.6 units: 60° high from 14.4 units, 16:9),
    // so screen-wide effects like bloom reach as far as in the game, and all are rendered within the same
    // game frame, so nothing moves between them. The dappled-sunlight overlay is drawn in screen space and
    // would repeat in every tile: it stays off (in the game it drifts over the screen anyway).
    // `mask`: grade through this light mask instead of the lamps' (white: everything lit).
    const int TileW = 4096, TileH = 2048, Border = 4;

    void ShootTiles(string folder, RenderTexture mask = null)
    {
        Directory.CreateDirectory(folder);
        float p = ppu.Value;
        int W = Mathf.CeilToInt((U1 - U0) * p), H = Mathf.CeilToInt((V1 - V0) * p);
        int cols = (W + TileW - 1) / TileW, rows = (H + TileH - 1) / TileH;
        int RW = Mathf.Max(TileW + 2 * Border, Mathf.RoundToInt(29.5f * p)), RH = Mathf.Max(TileH + 2 * Border, Mathf.RoundToInt(16.6f * p));
        var hidden = HideForCapture(clean: true);
        var overlay = ScreenSpaceOverlay.Instance ? ScreenSpaceOverlay.Instance.GetRenderer() : null;
        bool overlayWas = overlay && overlay.enabled;
        if (overlay) overlay.enabled = false;
        var switchedOff = ScreenEffectsOff(); // colour grading and bloom stay
        var fx = StencilLighting_MaskEffect.Instance;
        bool disabled = StencilLighting_MaskEffect.DisableRender;
        var oldMask = fx && fx.amplifyPostEffect ? fx.amplifyPostEffect.MaskTexture.value : null;
        try
        {
            if (mask && fx && fx.amplifyPostEffect) { StencilLighting_MaskEffect.DisableRender = true; fx.amplifyPostEffect.MaskTexture.Override(mask); }
            var cam = GameCamera();
            for (int r = 0; r < rows; r++)
                for (int c = 0; c < cols; c++)
                {
                    // the tile's centre on the ground (z = 0): u = x, v = K * y
                    float u = U0 + (c * TileW + TileW / 2f) / p, v = V1 - (r * TileH + TileH / 2f) / p;
                    var tex = Render(cam, RW, RH, RH / (2 * p), new Vector3(u, v / K, 0f), cam.cullingMask, Color.black, post: true, alpha: false,
                        read: new RectInt((RW - TileW) / 2 - Border, (RH - TileH) / 2 - Border, TileW + 2 * Border, TileH + 2 * Border));
                    File.WriteAllBytes(Path.Combine(folder, $"{c}_{r}.png"), tex.EncodeToPNG());
                    Destroy(tex);
                }
            Logger.LogInfo($"wrote {folder}: {cols}x{rows} tiles of {TileW}x{TileH} at {p} px per unit ({W}x{H}), hid {hidden.Count} renderers");
        }
        finally
        {
            if (mask && fx && fx.amplifyPostEffect) { fx.amplifyPostEffect.MaskTexture.value = oldMask; StencilLighting_MaskEffect.DisableRender = disabled; mask.Release(); }
            if (overlay) overlay.enabled = overlayWas;
            Unhide(hidden);
            foreach (var fxs in switchedOff) if (fxs) fxs.active = true;
        }
    }

    // `mask`: grade through this light mask instead of the lamps' (white: everything lit).
    void Shoot(string path, bool clean, bool hideWorldUI = true, RenderTexture mask = null)
    {
        var hidden = HideForCapture(clean, hideWorldUI: hideWorldUI);
        var switchedOff = ScreenEffectsOff(); // colour grading and bloom stay
        var fx = StencilLighting_MaskEffect.Instance;
        bool disabled = StencilLighting_MaskEffect.DisableRender;
        var oldMask = fx && fx.amplifyPostEffect ? fx.amplifyPostEffect.MaskTexture.value : null;
        try
        {
            if (mask && fx && fx.amplifyPostEffect) { StencilLighting_MaskEffect.DisableRender = true; fx.amplifyPostEffect.MaskTexture.Override(mask); }
            var cam = GameCamera();
            int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
            // centre of the box on the ground (z = 0): u = x, v = K * y
            var centre = new Vector3((U0 + U1) / 2f, (V0 + V1) / 2f / K, 0f);
            var tex = Render(cam, w, h, (V1 - V0) / 2f, centre, cam.cullingMask, Color.black, post: true, alpha: false);
            File.WriteAllBytes(path, tex.EncodeToPNG());
            Destroy(tex);
            Logger.LogInfo($"wrote {path} {w}x{h}, hid {hidden.Count} renderers, switched off {switchedOff.Count} screen effects");
        }
        finally
        {
            if (mask && fx && fx.amplifyPostEffect) { fx.amplifyPostEffect.MaskTexture.value = oldMask; StencilLighting_MaskEffect.DisableRender = disabled; mask.Release(); }
            Unhide(hidden);
            foreach (var fxs in switchedOff) if (fxs) fxs.active = true;
        }
    }

    // Hides what a capture leaves out: the UI, the player, and with `clean` followers, placed buildings
    // (not the base's own) and particles (fireflies, dust, weather). Returns what it hid, for Unhide.
    static List<Component> HideForCapture(bool clean, bool hideWorldUI = true)
    {
        var hidden = new List<Component>();
        void Off(Renderer r) { if (r && r.enabled) { r.enabled = false; hidden.Add(r); } }
        foreach (var c in FindObjectsOfType<Canvas>()) if (c.enabled) { c.enabled = false; hidden.Add(c); }
        foreach (var r in FindObjectsOfType<Renderer>())
        {
            if (hideWorldUI && r is SpriteRenderer && r.sortingLayerName.Contains("UI")) Off(r); // world-space bars and icons
            else if (clean && (r is ParticleSystemRenderer || IsFirefly(r.transform))) Off(r);
        }
        foreach (var p in PlayerFarming.players) if (p) foreach (var r in p.GetComponentsInChildren<Renderer>(true)) Off(r);
        if (clean)
        {
            foreach (var f in FindObjectsOfType<Follower>()) foreach (var r in f.GetComponentsInChildren<Renderer>(true)) Off(r);
            foreach (var s in FindObjectsOfType<Structure>())
                if (!Keep.Contains(s.Type.ToString())) foreach (var r in s.GetComponentsInChildren<Renderer>(true)) Off(r);
        }
        return hidden;
    }

    // The game opens menus (tutorials, onboarding) on its own and stops its clock (time scale 0) while one is
    // open, which would freeze animation and the time of day for the rest of the capture: close it.
    void Unpause(string when)
    {
        var menu = MonoSingleton<UIManager>.Instance ? MonoSingleton<UIManager>.Instance.CurrentMenu : null;
        if (menu) { Logger.LogWarning($"{when}: closing {menu.GetType().Name}, which paused the game"); menu.Hide(true); }
        if (Time.timeScale != 1f) { Logger.LogWarning($"{when}: time scale was {Time.timeScale}"); Time.timeScale = 1f; }
    }

    static bool IsFirefly(Transform t) { for (; t; t = t.parent) if (t.name.StartsWith("Firefly")) return true; return false; } // wanders; its light would freeze into the backdrop

    static void Unhide(List<Component> hidden)
    {
        foreach (var c in hidden) if (c is Renderer r && r) r.enabled = true; else if (c is Canvas cv && cv) cv.enabled = true;
    }

    static Camera GameCamera()
    {
        var follow = CameraFollowTarget.Instance;
        return follow ? (follow.GetComponent<Camera>() ?? follow.GetComponentInChildren<Camera>()) : Camera.main;
    }

    // One frame from the game camera looking down at 45° without perspective, centred on a ground
    // point. Rendering only some layers clears to `background`; post = false skips post-processing.
    static Texture2D Render(Camera cam, int w, int h, float orthoSize, Vector3 centre, int mask, Color background, bool post, bool alpha, RectInt? read = null)
    {
        var follow = CameraFollowTarget.Instance;
        bool followWas = follow && follow.enabled;
        var t = cam.transform;
        Vector3 pos = t.position;
        Quaternion rot = t.rotation;
        bool ortho = cam.orthographic;
        float size = cam.orthographicSize, fov = cam.fieldOfView, near = cam.nearClipPlane, far = cam.farClipPlane;
        int oldMask = cam.cullingMask;
        var oldClear = cam.clearFlags;
        var oldBackground = cam.backgroundColor;
        var target = cam.targetTexture;
        var postLayer = cam.GetComponent<PostProcessLayer>();
        bool postWas = postLayer && postLayer.enabled;
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        // The grading reads the lamps' light mask, which the game only draws for its own frames; this frame
        // gets one drawn for it (LightMask). Skipped when a caller set the mask itself (DisableRender).
        var fx = StencilLighting_MaskEffect.Instance;
        bool ownMask = fx && fx.amplifyPostEffect && !StencilLighting_MaskEffect.DisableRender && post;
        var gameMask = ownMask ? fx.amplifyPostEffect.MaskTexture.value : null;
        var captureMask = ownMask ? LightMask(cam, w, h, orthoSize, centre, mask) : null;
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
            if (ownMask)
            {
                StencilLighting_MaskEffect.DisableRender = true;
                fx.amplifyPostEffect.MaskTexture.Override(captureMask);
            }
            if (postLayer && !post) postLayer.enabled = false;
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var area = read ?? new RectInt(0, 0, w, h); // only this part of the frame
            var tex = new Texture2D(area.width, area.height, alpha ? TextureFormat.RGBA32 : TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(area.x, area.y, area.width, area.height), 0, 0);
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
            cam.fieldOfView = fov;
            cam.nearClipPlane = near;
            cam.farClipPlane = far;
            cam.cullingMask = oldMask;
            cam.clearFlags = oldClear;
            cam.backgroundColor = oldBackground;
            if (postLayer) postLayer.enabled = postWas;
            if (follow) follow.enabled = followWas;
            if (ownMask)
            {
                fx.amplifyPostEffect.MaskTexture.value = gameMask;
                StencilLighting_MaskEffect.DisableRender = false;
                captureMask.Release();
            }
        }
    }

    // The lamps' light mask for a frame of Render's: what the game's lighting camera draws into it for its own
    // frames, in the middle of the main camera's render: the light layer, drawn with the camera's depth
    // texture in place (the lights are decals projected onto what's there). Here a command buffer does
    // that at the same point of a render of the same frame. The light shaders rebuild positions as seen by
    // the game's perspective camera, so that render is a perspective one with a tiny field of view from far
    // away: the frame Render takes without perspective, to within 0.1 unit at the far corners of a backdrop.
    // Only the red channel counts (the grading's blend). The caller releases the texture.
    static RenderTexture LightMask(Camera cam, int w, int h, float orthoSize, Vector3 centre, int mask)
    {
        const float Fov = .3f;
        float distance = orthoSize / Mathf.Tan(Fov / 2 * Mathf.Deg2Rad);
        var follow = CameraFollowTarget.Instance;
        bool followWas = follow && follow.enabled;
        var t = cam.transform;
        Vector3 pos = t.position;
        Quaternion rot = t.rotation;
        bool ortho = cam.orthographic;
        float fov = cam.fieldOfView, near = cam.nearClipPlane, far = cam.farClipPlane;
        int oldMask = cam.cullingMask;
        var depthMode = cam.depthTextureMode;
        var target = cam.targetTexture;
        var postLayer = cam.GetComponent<PostProcessLayer>();
        bool postWas = postLayer && postLayer.enabled;
        var fx = StencilLighting_MaskEffect.Instance;
        bool fxWas = fx && fx.enabled;
        var lightMask = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32);
        lightMask.Create(); // a command buffer won't create it, and draws into nothing
        var frame = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        var lights = new CommandBuffer { name = "PlannerCapture light mask" };
        lights.SetRenderTarget(new RenderTargetIdentifier(lightMask), new RenderTargetIdentifier(frame)); // the frame's depth, as the game's
        lights.ClearRenderTarget(false, true, Color.clear);
        foreach (var r in FindObjectsOfType<Renderer>())
            if (r.enabled && r.gameObject.activeInHierarchy && r.gameObject.layer == LightLayer)
                for (int m = 0; m < r.sharedMaterials.Length; m++) if (r.sharedMaterials[m]) lights.DrawRenderer(r, r.sharedMaterials[m], m);
        try
        {
            if (follow) follow.enabled = false;
            if (fx) fx.enabled = false; // the game's own mask pass
            if (postLayer) postLayer.enabled = false;
            t.rotation = Quaternion.Euler(-45f, 0f, 0f);
            t.position = centre - t.forward * distance;
            cam.orthographic = false;
            cam.fieldOfView = Fov;
            cam.nearClipPlane = distance - 150f;
            cam.farClipPlane = distance + 150f;
            cam.cullingMask = mask;
            cam.depthTextureMode |= DepthTextureMode.Depth;
            cam.targetTexture = frame;
            cam.AddCommandBuffer(CameraEvent.AfterForwardAlpha, lights);
            cam.Render();
            return lightMask;
        }
        finally
        {
            cam.RemoveCommandBuffer(CameraEvent.AfterForwardAlpha, lights);
            lights.Release();
            cam.targetTexture = target;
            frame.Release();
            t.position = pos;
            t.rotation = rot;
            cam.orthographic = ortho;
            cam.fieldOfView = fov;
            cam.nearClipPlane = near;
            cam.farClipPlane = far;
            cam.cullingMask = oldMask;
            cam.depthTextureMode = depthMode;
            if (postLayer) postLayer.enabled = postWas;
            if (fx) fx.enabled = fxWas;
            if (follow) follow.enabled = followWas;
        }
    }
}
