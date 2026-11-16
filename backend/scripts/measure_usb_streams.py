"""Bounded concurrent MJPEG receipt and telemetry diagnostics on the same host."""

import argparse
import concurrent.futures
import json
from pathlib import Path
import statistics
import time
from urllib.request import urlopen


def summary(values):
    ordered = sorted(values)
    return {'mean': statistics.mean(ordered), 'p95': ordered[min(len(ordered)-1, int(len(ordered)*.95))],
            'max': max(ordered)} if ordered else None


def measure(url, seconds):
    times, ages, sizes, sequences = [], [], [], []
    buffer = b''
    started = time.perf_counter()
    try:
        with urlopen(url, timeout=8) as response:
            headers = dict(response.headers)
            while time.perf_counter() - started < seconds:
                chunk = response.read1(65536)
                if not chunk:
                    break
                buffer += chunk
                while b'\xff\xd9\r\n' in buffer:
                    end = buffer.index(b'\xff\xd9\r\n') + 4
                    part, buffer = buffer[:end], buffer[end:]
                    now = time.perf_counter()
                    head, separator, body = part.partition(b'\r\n\r\n')
                    if not separator or not body.startswith(b'\xff\xd8'):
                        continue
                    times.append(now)
                    sizes.append(len(body)-2)
                    fields = dict(line.split(b': ', 1) for line in head.split(b'\r\n') if b': ' in line)
                    if b'X-Captured-At' in fields:
                        ages.append((now-float(fields[b'X-Captured-At']))*1000)
                    if b'X-Frame-Sequence' in fields:
                        sequences.append(int(fields[b'X-Frame-Sequence']))
            return dict(url=url, frames=len(times),
                        received_fps=(len(times)-1)/(times[-1]-times[0]) if len(times)>1 else 0,
                        first_frame_ms=(times[0]-started)*1000 if times else None,
                        software_capture_to_receipt_ms=summary(ages),
                        inter_frame_ms=summary([(b-a)*1000 for a,b in zip(times,times[1:])]),
                        jpeg_bytes=summary(sizes), frame_sequences=sequences, headers=headers)
    except Exception as error:
        return dict(url=url, error=str(error), frames=len(times))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=10)
    parser.add_argument('--warmup-seconds', type=float, default=60)
    parser.add_argument('--direct', default='http://127.0.0.1:5000')
    parser.add_argument('--proxy', default='http://127.0.0.1:3000/detection')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output exists; choose a new evidence path')
    ready_deadline = time.monotonic() + args.warmup_seconds
    warmup = {'ready': False}
    while time.monotonic() < ready_deadline:
        try:
            with urlopen(f'{args.direct}/api/system/status',timeout=4) as response:
                status = json.load(response)
            cameras = status.get('cameras', [])
            if len(cameras) == 2 and all(c.get('online') and c.get('frameAgeMs') is not None
                                         and c.get('processingHealth') == 'running' for c in cameras):
                warmup = {'ready': True}
                break
        except Exception as error:
            warmup['last_error'] = str(error)
        time.sleep(1)
    if not warmup['ready']:
        parser.error(f'Both inference workers did not warm up: {warmup}')
    urls = [f'{base}/video/{kind}camera/{index}' for base in (args.direct,args.proxy)
            for kind in ('raw/', '') for index in (1,2)]
    telemetry = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(urls)) as pool:
        futures = [pool.submit(measure,url,args.seconds) for url in urls]
        started = time.perf_counter()
        while time.perf_counter()-started < args.seconds:
            try:
                with urlopen(f'{args.direct}/api/system/status',timeout=4) as response:
                    data = json.load(response)
                    telemetry.append({'at':time.perf_counter(), 'cameras':data.get('cameras'),
                                      'observationOnly':data.get('observationOnly')})
            except Exception as error:
                telemetry.append({'error':str(error)})
            time.sleep(.5)
        streams = [future.result() for future in futures]
    report = dict(streams=streams, telemetry=telemetry, warmup=warmup,
                  age_scope='Host post-read/decode to HTTP receipt; excludes sensor, driver and browser presentation')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps({'streams':[{k:v for k,v in stream.items() if k not in ('frame_sequences','headers')}
                                  for stream in streams], 'telemetry_samples':len(telemetry)},indent=2))


if __name__ == '__main__':
    main()
