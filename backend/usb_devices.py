"""DirectShow discovery without opening cameras or assuming device identities."""

import sys


def enumerate_usb_devices() -> list[dict] | None:
    """None means discovery unavailable; [] means no video devices were found.

    DirectShow's video-input order is the order consumed by OpenCV CAP_DSHOW.
    Names are display labels, not unique physical identifiers. Never deduplicate
    equal names: two webcams of the same model can be separate devices.
    """
    if sys.platform != "win32":
        return None
    try:
        import comtypes
        from pygrabber.dshow_graph import FilterGraph

        comtypes.CoInitialize()
        try:
            graph = FilterGraph()
            try:
                return [{"index": index, "name": name} for index, name in enumerate(graph.get_input_devices())]
            finally:
                del graph
        finally:
            comtypes.CoUninitialize()
    except Exception:
        # Missing optional dependency/driver/COM support must not break RTSP.
        return None


def usb_catalog(config, devices: list[dict] | None) -> list[dict]:
    configured = {config.web_camera_index, getattr(config, "logi_c270_camera_index", config.dv20_camera_index)}
    catalog = {device["index"]: {**device, "available": True} for device in devices or []}
    for index in sorted(configured):
        if index >= 0 and index not in catalog:
            catalog[index] = {
                "index": index,
                "name": f"USB device {index} ({'unavailable' if devices is not None else 'unverified'})",
                "available": False if devices is not None else None,
            }
    return [catalog[index] for index in sorted(catalog)]
