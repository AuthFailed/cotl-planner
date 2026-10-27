// BepInEx 5 plugin: renders the cult base with the game's own camera, lighting and shaders,
// looking down at 45° without perspective (the planner's projection), and saves PNGs.
//
// Flow: on the main menu it continues the configured save slot, waits for the base to settle,
// switches saving off, captures "full.png" (as the save looks) and "clean.png" (no placed
// structures, obstacles, followers or player), writes capture.json and quits.
// It never writes the save: SaveAndLoad, metadata and persistence saves are blocked while installed.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using MMTools;
using src.Managers;
using UnityEngine;
using UnityEngine.Rendering.PostProcessing;
using UnityEngine.SceneManagement;

[BepInPlugin("chrsnv.cotlplanner.capture", "COTL Planner Capture", "1.0.0")]
public class PlannerCapture : BaseUnityPlugin
{
    // Area to capture, in the planner's projected world units: u = x, v = cos45 * (y - z).
    // The tools/background box (base region plus a margin), extended south over the extra land.
    const float U0 = -33.858737f, U1 = 34.224524f, V0 = -46f, V1 = 15.101617f;
    const float K = 0.70710678f;

    // Fixed structures that belong to the default base and stay in the clean capture.
    static readonly HashSet<string> Keep = new HashSet<string> {
        "SHRINE", "SHRINE_II", "SHRINE_III", "SHRINE_IV", "SHRINE_BASE", "TEMPLE", "TEMPLE_II", "TEMPLE_III", "TEMPLE_IV",
        "TEMPLE_BASE", "TEMPLE_BASE_EXTENSION1", "TEMPLE_BASE_EXTENSION2", "COLLECTED_RESOURCES_CHEST", "MISSION_SHRINE",
        "DANCING_FIREPIT", "FEAST_TABLE", "RATAU_SHRINE", "PLACEMENT_REGION", "FIRE", "FISHING_SPOT",
    };

    ConfigEntry<int> slot, width;
    ConfigEntry<float> settle;
    ConfigEntry<bool> autoLoad, forceDay, quitAfter;
    string outDir;
    bool started, done;

    void Awake()
    {
        slot = Config.Bind("Capture", "SaveSlot", 0, "Save slot to continue from the main menu.");
        width = Config.Bind("Capture", "Width", 6144, "Output width in pixels (height follows the area's aspect).");
        settle = Config.Bind("Capture", "SettleSeconds", 25f, "Seconds to wait in the base before capturing.");
        autoLoad = Config.Bind("Capture", "AutoLoad", true, "Continue the save automatically from the main menu.");
        forceDay = Config.Bind("Capture", "ForceDay", true, "Move the clock to the afternoon before capturing.");
        quitAfter = Config.Bind("Capture", "QuitAfter", true, "Quit the game after capturing.");
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
        yield return new WaitForEndOfFrame();
        try
        {
            Shoot("full", clean: false);
            Shoot("clean", clean: true);
            int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
            File.WriteAllText(Path.Combine(outDir, "capture.json"),
                $"{{\"ppu\":{w / (U1 - U0):0.####},\"w\":{w},\"h\":{h},\"u_left\":{U0},\"v_top\":{V1},\"time\":\"{DateTime.Now:s}\"}}");
            Logger.LogInfo("capture done");
        }
        catch (Exception e) { Logger.LogError(e); }
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

    void Shoot(string name, bool clean)
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

        var follow = CameraFollowTarget.Instance;
        var cam = follow ? (follow.GetComponent<Camera>() ?? follow.GetComponentInChildren<Camera>()) : Camera.main;
        bool followWas = follow && follow.enabled;
        if (follow) follow.enabled = false;
        var t = cam.transform;
        Vector3 pos = t.position; Quaternion rot = t.rotation;
        bool ortho = cam.orthographic; float size = cam.orthographicSize, near = cam.nearClipPlane, far = cam.farClipPlane;
        var target = cam.targetTexture;

        int w = width.Value, h = Mathf.RoundToInt(w * (V1 - V0) / (U1 - U0));
        // centre of the box on the ground (z = 0): u = x, v = K * y
        float cu = (U0 + U1) / 2f, cv = (V0 + V1) / 2f;
        t.rotation = Quaternion.Euler(-45f, 0f, 0f); // forward (0, .707, .707), up (0, .707, -.707): v = K (y - z)
        t.position = new Vector3(cu, cv / K, 0f) - t.forward * 80f;
        cam.orthographic = true;
        cam.orthographicSize = (V1 - V0) / 2f;
        cam.nearClipPlane = 1f;
        cam.farClipPlane = 300f;
        var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
        try
        {
            cam.targetTexture = rt;
            cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            tex.Apply();
            File.WriteAllBytes(Path.Combine(outDir, name + ".png"), tex.EncodeToPNG());
            Destroy(tex);
            Logger.LogInfo($"wrote {name}.png {w}x{h}, hid {hiddenRenderers.Count} renderers, switched off {switchedOff.Count} screen effects");
        }
        finally
        {
            RenderTexture.active = null;
            cam.targetTexture = target;
            rt.Release();
            t.position = pos; t.rotation = rot;
            cam.orthographic = ortho; cam.orthographicSize = size; cam.nearClipPlane = near; cam.farClipPlane = far;
            if (follow) follow.enabled = followWas;
            foreach (var r in hiddenRenderers) if (r) r.enabled = true;
            foreach (var c in hiddenCanvases) if (c) c.enabled = true;
            foreach (var fx in switchedOff) if (fx) fx.active = true;
        }
    }
}
