from unittest.mock import Mock

import pytest

import run_local


def test_development_launch_is_preserved():
    assert run_local.frontend_command("npm.cmd", "development") == ["npm.cmd", "run", "dev"]


def test_production_requires_a_build_before_starting_any_process(monkeypatch, tmp_path):
    monkeypatch.setattr(run_local, "PROJECT_DIR", tmp_path)
    spawn = Mock()
    monkeypatch.setattr(run_local.subprocess, "Popen", spawn)
    with pytest.raises(SystemExit, match="npm run build"):
        run_local.frontend_command("npm.cmd", "production")
    spawn.assert_not_called()
    (tmp_path / ".next").mkdir()
    (tmp_path / ".next" / "BUILD_ID").write_text("test-build")
    assert run_local.frontend_command("npm.cmd", "production") == ["npm.cmd", "run", "start"]
