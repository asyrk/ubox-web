const NATIVE_TWO_CAMERA_VREXTTYPES = new Set([4, 6, 7, 8, 9]);
const NATIVE_TWO_SENSOR_VREXTTYPES = new Set([8, 9]);
const NATIVE_T23_THREE_EYE_TYPES = new Set([26, 27]);

function flattenObject(object, prefix = "", out = {}) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return out;
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, path, out);
    } else {
      out[path] = value;
    }
  }
  return out;
}

function firstNumber(flat, keys) {
  for (const key of keys) {
    const value = flat[key];
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function getNativeCameraLayout(device) {
  const flat = flattenObject(device);
  const vrexttype = firstNumber(flat, [
    "vrexttype",
    "device_type",
    "deviceType",
    "raw.vrexttype",
    "raw.device_type",
    "raw.deviceType",
  ]);
  const modelDeviceType = firstNumber(flat, [
    "model_dev_type",
    "modelDeviceType",
    "raw.model_dev_type",
    "raw.modelDeviceType",
  ]);
  const splitView = firstNumber(flat, ["split_view", "splitView", "raw.split_view", "raw.splitView"]);
  const isTwoCamera = NATIVE_TWO_CAMERA_VREXTTYPES.has(vrexttype);
  const isTwoSensor = NATIVE_TWO_SENSOR_VREXTTYPES.has(vrexttype);
  const isT23ThreeEye = NATIVE_T23_THREE_EYE_TYPES.has(modelDeviceType);
  const isSplitView = splitView === 1;

  return {
    vrexttype,
    modelDeviceType,
    splitView,
    isTwoCamera,
    isTwoSensor,
    isT23ThreeEye,
    isSplitView,
    showSecondaryStream: isTwoSensor,
  };
}
