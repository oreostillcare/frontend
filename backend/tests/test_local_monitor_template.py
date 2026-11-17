from html.parser import HTMLParser
from pathlib import Path
import subprocess

from flask import Flask, render_template
import pytest


class MonitorMarkup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.controls = {}
        self.scripts = []
        self.in_script = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.controls[attributes["id"]] = attributes
        if tag == "script":
            self.in_script = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        if self.in_script:
            self.scripts.append(data)


@pytest.mark.parametrize("observation_only", [False, True])
@pytest.mark.parametrize("display_mirror", [False, True])
@pytest.mark.parametrize("reset_available", [False, True])
def test_rendered_monitor_controls_and_javascript(observation_only, display_mirror, reset_available):
    # Biome cannot parse Jinja control blocks; validate the rendered output instead.
    app = Flask(__name__, template_folder=str(Path(__file__).resolve().parents[1] / "templates"))
    with app.app_context():
        html = render_template(
            "local_monitor.html",
            detection_fps=5,
            line_counting=True,
            observation_only=observation_only,
            display_mirror=display_mirror,
            reset_available=reset_available,
            test_reset_token='test-token-"quoted"-<escaped>',
            camera_devices=[{"index": 1, "name": 'Webcam "A"'}, {"index": 2, "name": "Webcam B"}],
            camera_sources={1: 1, 2: 2},
        )
    assert "{%" not in html and "{{" not in html
    markup = MonitorMarkup()
    markup.feed(html)
    assert ("disabled" in markup.controls["reset-test-state"]) is observation_only
    assert ("disabled" in markup.controls["reset-system"]) is not reset_available
    assert ("disabled" in markup.controls["camera-2-source"]) is display_mirror
    assert "/video/camera/1" in html and "/video/camera/2" in html
    assert markup.scripts
    result = subprocess.run(["node", "--check"], input="\n".join(markup.scripts), encoding="utf-8", capture_output=True)
    assert result.returncode == 0, result.stderr
