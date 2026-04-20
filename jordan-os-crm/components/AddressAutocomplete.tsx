"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google: any;
    initGooglePlaces?: () => void;
  }
}

let scriptLoaded = false;
let scriptLoading = false;
const readyCallbacks: (() => void)[] = [];

function loadGooglePlaces(apiKey: string, onReady: () => void) {
  if (scriptLoaded) { onReady(); return; }
  readyCallbacks.push(onReady);
  if (scriptLoading) return;
  scriptLoading = true;
  window.initGooglePlaces = () => {
    scriptLoaded = true;
    readyCallbacks.forEach(cb => cb());
    readyCallbacks.length = 0;
  };
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=initGooglePlaces`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

export default function AddressAutocomplete({ value, onChange, placeholder = "123 Main St, City, CA 90001", className, style }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autocompleteRef = useRef<any>(null);
  const [ready, setReady] = useState(scriptLoaded);

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;
    const ac = new window.google.maps.places.Autocomplete(inputRef.current, {
      types: ["address"],
      componentRestrictions: { country: "us" },
      fields: ["formatted_address"],
    });
    ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (place.formatted_address) {
        onChange(place.formatted_address);
      }
    });
    autocompleteRef.current = ac;
  }, [onChange]);

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!apiKey) return;
    loadGooglePlaces(apiKey, () => {
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) initAutocomplete();
  }, [ready, initAutocomplete]);

  return (
    <input
      ref={inputRef}
      className={className ?? "input"}
      style={style}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="new-password"
      data-1p-ignore
    />
  );
}
