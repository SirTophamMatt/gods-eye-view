import * as Cesium from 'cesium';

/** Where the globe opens when no share link says otherwise. */
export const DEFAULT_LOCATION = Object.freeze({
  label: 'Melbourne, VIC',
  lon: 144.9631,
  lat: -37.8136,
});

/**
 * Open on DEFAULT_LOCATION with upstream's cinematic fly-in (flyToAustin in
 * src/camera.js): top-down from 25 km, then down to 600 m. The timing is
 * upstream's, which the QA scripts rely on.
 * @param {Cesium.Viewer} viewer
 * @returns {function(): void} Cancels the pending or running flight.
 */
export function flyToDefaultLocation(viewer, location = DEFAULT_LOCATION) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      location.lon,
      location.lat,
      25000,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        location.lon,
        location.lat,
        600,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(15),
        pitch: Cesium.Math.toRadians(-30),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
