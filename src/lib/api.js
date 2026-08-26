export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed: ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

export function flattenDevices(reply) {
  const data = reply?.data || {};
  const fromItems = (data.items || []).map((item) => ({
    uid: item.device_uid,
    name: item.device_name || item.ps_name || item.device_uid,
    owner: item.is_owner,
    source: "items",
    raw: item,
    devFunc: numberField(item.dev_func),
    ptzSupport: computePtzSupport(item),
    ptzPermission: hasPtzPermission(item),
  }));
  const fromInfos = (data.infos || []).map((info) => ({
    uid: info.device_uid,
    name: info.device_name || info.ps_name || info.device_uid,
    owner: info.is_owner,
    source: "infos",
    raw: info,
    devFunc: numberField(info.dev_func),
    ptzSupport: computePtzSupport(info),
    ptzPermission: hasPtzPermission(info),
  }));

  const merged = new Map();
  for (const device of [...fromItems, ...fromInfos]) {
    if (!device.uid) continue;
    merged.set(device.uid, { ...(merged.get(device.uid) || {}), ...device });
  }
  return [...merged.values()];
}

function numberField(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed >>> 0 : 0;
}

// dev_func bit 18 -> two-axis, bit 2 -> single-axis (app DeviceUtil).
function computePtzSupport(item) {
  const value = numberField(item?.dev_func);
  const hasBit = (index) => ((value >>> index) & 1) === 1;
  if (hasBit(18)) return "ptz2";
  if (hasBit(2)) return "ptz1";
  return "none";
}

// Owner or permissions containing "1" (app PermissionUtil).
function hasPtzPermission(item) {
  if (Number(item?.is_owner ?? item?.owner ?? 0) === 1) return true;
  const permissions = item?.permissions;
  return permissions == null || String(permissions).includes("1");
}
