"""显式知识审阅/发布操作使用的本机文件锁，不注册后台捕获。"""
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path


@contextmanager
def record_lock(target):
    root = Path(os.environ.get('PAWS_STATE_DIR', str(Path.home() / '.local/state/paws-oss')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = hashlib.sha256(str(target.resolve()).encode()).hexdigest()
    with (root / (name + '.lock')).open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            lock.write(b'0')
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == 'nt':
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)
