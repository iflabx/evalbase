import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** Keep typing immediate; commit one list query after IME composition and a short pause. */
export function useListSearch(resetPage: Dispatch<SetStateAction<number>>) {
  const [search, setValue] = useState("");
  const [committedSearch, setCommitted] = useState("");
  const [composing, setComposing] = useState(false);
  function commit(value: string) {
    setCommitted(value);
    resetPage(1);
  }
  function setSearch(value: string) {
    setValue(value);
    if (!value) commit("");
  }
  useEffect(() => {
    if (composing || search === committedSearch) return;
    const timer = window.setTimeout(() => {
      setCommitted(search);
      resetPage(1);
    }, 275);
    return () => window.clearTimeout(timer);
  }, [search, committedSearch, composing, resetPage]);
  return {
    search,
    committedSearch,
    setSearch,
    inputProps: {
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value),
      onCompositionStart: () => setComposing(true),
      onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement>) => {
        setValue(event.currentTarget.value);
        setComposing(false);
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" && !composing && !event.nativeEvent.isComposing) commit(search);
      },
    },
  };
}
