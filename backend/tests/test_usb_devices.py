from types import SimpleNamespace

import usb_devices


def test_catalog_keeps_identically_named_physical_devices_separate():
    config = SimpleNamespace(web_camera_index=0, logi_c270_camera_index=1, dv20_camera_index=2)
    result = usb_devices.usb_catalog(config, [
        {"index": 0, "name": "USB Webcam"}, {"index": 1, "name": "USB Webcam"},
    ])
    assert [item["index"] for item in result] == [0, 1]
    assert all(item["available"] for item in result)


def test_catalog_marks_missing_configured_index_without_fabricating_device():
    config = SimpleNamespace(web_camera_index=0, logi_c270_camera_index=4, dv20_camera_index=2)
    result = usb_devices.usb_catalog(config, [{"index": 0, "name": "Webcam A"}])
    assert result[0]["available"] is True
    assert result[1] == {"index": 4, "name": "USB device 4 (unavailable)", "available": False}


def test_discovery_unavailable_is_not_reported_as_zero_connected_devices(monkeypatch):
    monkeypatch.setattr(usb_devices.sys, "platform", "unsupported")
    assert usb_devices.enumerate_usb_devices() is None
    config = SimpleNamespace(web_camera_index=0, logi_c270_camera_index=1, dv20_camera_index=2)
    assert all(item["available"] is None for item in usb_devices.usb_catalog(config, None))
