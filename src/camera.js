import * as Cesium from 'cesium';

/**
 * The view the app opens on when a share link has not already pinned one.
 *
 * Melbourne, because the Passive Monitor hazard layers (PM Fire, PM Flood,
 * PM Storm, PM Power) are Victorian and this is the only opening view from
 * which they are on screen rather than on the far side of the planet.
 *
 * Keep the label in step with the coordinates — main.js shows it during the
 * fly-in, so a stale label would announce the wrong city.
 */
export const DEFAULT_LOCATION = Object.freeze({
  label: 'Melbourne, VIC',
  lon: 144.9631,
  lat: -37.8136,
});

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  melbourne: {
    destination: Cesium.Cartesian3.fromDegrees(
      DEFAULT_LOCATION.lon,
      DEFAULT_LOCATION.lat,
      800,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Open on DEFAULT_LOCATION with a cinematic fly-in: a high top-down
 * establishing frame, then a descent to street altitude.
 *
 * The 500 ms pause before the descent is load-bearing for the QA harnesses
 * (scripts/qa-labels.mjs, scripts/qa-label-readability.mjs), which either
 * cancel this flight or wait it out before setting their own measurement
 * camera. Changing the timing shifts what they sample; changing the
 * destination does not.
 */
export function flyToDefaultLocation(viewer) {
  const { lon, lat } = DEFAULT_LOCATION;

  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 600),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
}
