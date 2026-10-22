# Source me: makes KITH_<X> and the old HQ_<X> agree for every exported variable (KITH_ wins, the other fills in).
# The kernel reads KITH_<X> only; agent role repos written before the rename read HQ_<X>, so a run sets both.
# HQ_BIN (the kernel's command, which the host runs) is KITH_KERNEL_BIN: KITH_BIN already names the kith binary.
# Python twin: sync_env() in kith_paths.py. Call kith_env_sync again after exporting new KITH_ variables, before
# starting anything that is not the kernel.
kith_env_sync() {
  local n k b
  for n in $(compgen -e); do
    case $n in
      HQ_*) b=${n#HQ_}; [[ $b == BIN ]] && b=KERNEL_BIN; k="KITH_$b"; [[ -n ${!k:-} ]] || export "$k=${!n}" ;;
    esac
  done
  for n in $(compgen -e); do
    case $n in
      KITH_*)
        b=${n#KITH_}
        [[ $b == BIN || -z ${!n} ]] && continue
        [[ $b == KERNEL_BIN ]] && b=BIN
        export "HQ_$b=${!n}" ;;
    esac
  done
}
kith_env_sync
