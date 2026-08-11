import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../modules/toast.js';

const CONFIRM_WINDOW_MS = 4000;

export function useConfirmPress() {
  const [armedKey, setArmedKey] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const isArmed = useCallback((key) => armedKey === key, [armedKey]);

  const confirmPress = useCallback(
    (key, label) => {
      if (armedKey === key) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        setArmedKey(null);
        return true;
      }

      window.clearTimeout(timerRef.current);
      setArmedKey(key);
      timerRef.current = window.setTimeout(() => {
        setArmedKey((current) => (current === key ? null : current));
        timerRef.current = null;
      }, CONFIRM_WINDOW_MS);
      toast.warning(`${label}，再点一次确认`);
      return false;
    },
    [armedKey]
  );

  return { isArmed, confirmPress };
}

export default useConfirmPress;
