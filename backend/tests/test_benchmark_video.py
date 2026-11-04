import ast
from pathlib import Path
from unittest.mock import Mock

import pytest

from scripts.benchmark_video import selected_frame, stats


def test_tail_statistics_do_not_hide_a_single_slow_frame():
    result = stats([10] * 98 + [100, 1000])
    assert result["p50"] == 10 and result["p95"] == 10
    assert result["p99"] == 100 and result["max"] == 1000
    assert result["count"] == 100


def test_decode_failure_is_not_replaced_with_a_different_frame():
    capture = Mock()
    capture.grab.side_effect = [True, False]
    with pytest.raises(RuntimeError, match="advancing"):
        selected_frame(capture, 2)
    capture.read.assert_not_called()


def test_selected_frame_advances_exactly_the_requested_stride():
    capture = Mock()
    frame = object()
    capture.read.return_value = (True, frame)
    result, elapsed = selected_frame(capture, 2)
    assert result is frame and elapsed >= 0
    assert capture.grab.call_count == 2
    capture.read.assert_called_once()


def test_standalone_script_has_no_live_application_or_network_entrypoints():
    source = Path(__file__).parents[1] / "scripts/benchmark_video.py"
    tree = ast.parse(source.read_text())
    forbidden = {"app", "camera", "traffic_control", "traffic_transactions", "flask", "socket", "urllib", "requests"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not {alias.name.split(".")[0] for alias in node.names} & forbidden
        if isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in forbidden
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            assert node.func.attr not in {"imshow", "imwrite", "VideoWriter"}
