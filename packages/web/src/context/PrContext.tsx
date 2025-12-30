import { createContext, useContext, createSignal, type ParentComponent, type Accessor } from "solid-js";

interface PrContextValue {
  prUrl: Accessor<string | null>;
  setPrUrl: (url: string | null) => void;
}

const PrContext = createContext<PrContextValue>();

export const PrProvider: ParentComponent = (props) => {
  const [prUrl, setPrUrl] = createSignal<string | null>(null);

  return (
    <PrContext.Provider value={{ prUrl, setPrUrl }}>
      {props.children}
    </PrContext.Provider>
  );
};

export function usePrContext() {
  const context = useContext(PrContext);
  if (!context) {
    throw new Error("usePrContext must be used within a PrProvider");
  }
  return context;
}
