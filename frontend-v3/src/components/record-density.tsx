import { createContext, useContext, useState, type ReactNode } from "react";
import { AlignJustify, Check, Menu, Rows3, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type RecordDensity = "compact" | "standard" | "expanded";

const RecordDensityContext = createContext<{
  density: RecordDensity;
  setDensity: (density: RecordDensity) => void;
}>({ density: "compact", setDensity: () => undefined });

const densityOptions: Array<{
  id: RecordDensity;
  label: string;
  description: string;
  Icon: LucideIcon;
}> = [
  { id: "compact", label: "紧凑", description: "单行显示", Icon: Rows3 },
  { id: "standard", label: "适中", description: "最多 3 行", Icon: AlignJustify },
  { id: "expanded", label: "展开", description: "最多 6 行", Icon: Menu },
];

export function RecordDensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensity] = useState<RecordDensity>("compact");
  return <RecordDensityContext value={{ density, setDensity }}>{children}</RecordDensityContext>;
}

// This hook is the public companion to the root-mounted provider above.
// eslint-disable-next-line react-refresh/only-export-components
export function useRecordDensity() {
  return useContext(RecordDensityContext);
}

export function RecordDensityControl() {
  const { density, setDensity } = useRecordDensity();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="行高"
          title="行高"
          className="record-row-density-button"
        >
          <Menu aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="record-row-density-menu" role="menu" aria-label="行高">
        <h3>行高</h3>
        {densityOptions.map(({ id, label, description, Icon }) => (
          <button
            key={id}
            type="button"
            role="menuitemradio"
            aria-checked={density === id}
            className="record-row-density-option"
            onClick={() => {
              setDensity(id);
              setOpen(false);
            }}
          >
            <Icon aria-hidden="true" />
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
            {density === id ? <Check className="density-check" aria-hidden="true" /> : <span />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
