import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from modules.live_monitoring.inference_runtime import OpenVINORequestAdapter, predictor_factory
