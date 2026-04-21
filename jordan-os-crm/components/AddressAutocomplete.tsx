"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface PlaceData {
  formatted_address: string;
  neighborhood: string | null;
  city: string | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onPlaceSelect?: (data: PlaceData) => void;
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

function extractFromComponents(components: any[], type: string): string | null {
  return components.find((c: any) => c.types.includes(type))?.long_name ?? null;
}

export default function AddressAutocomplete({ value, onChange, onPlaceSelect, placeholder = "123 Main St, City, CA 90001", className, style }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autocompleteRef = useRef<any>(null);
  const [ready, setReady] = useState(scriptLoaded);

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;
    const ac = new window.google.maps.places.Autocomplete(inputRef.current, {
      types: ["address"],
      componentRestrictions: { country: "us" },
      fields: ["formatted_address", "address_components"],
    });
    ac.addListener("place_changed", () => {
      const place = ac.getPlace();
      if (place.formatted_address) {
        onChange(place.formatted_address);
        if (onPlaceSelect) {
          const comps: any[] = place.address_components ?? [];
          // neighborhood → sublocality_level_1 → sublocality → null
          const neighborhood =
            extractFromComponents(comps, "neighborhood") ??
            extractFromComponents(comps, "sublocality_level_1") ??
            extractFromComponents(comps, "sublocality") ??
            null;
          const city = extractFromComponents(comps, "locality") ?? null;
          onPlaceSelect({ formatted_address: place.formatted_address, neighborhood, city });
        }
      }
    });
    autocompleteRef.current = ac;
  }, [onChange, onPlaceSelect]);

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
