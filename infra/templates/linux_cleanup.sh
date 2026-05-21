# Stop services that hold open files we're about to delete
sudo systemctl stop rsyslog 2>/dev/null

# Reset cloud-init so it runs fresh on every clone
sudo cloud-init clean --logs --seed

# Force unique SSH host keys per clone (regenerated on first boot)
sudo rm -f /etc/ssh/ssh_host_*

# Force unique machine-id per clone
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

# Shrink the template
sudo apt clean
sudo rm -rf /var/lib/apt/lists/*
sudo journalctl --vacuum-size=10M
sudo find /var/log -type f -exec truncate -s 0 {} \;

# Clear shell history
history -c && history -w
sudo rm -f /root/.bash_history /home/*/.bash_history

# Optional: zero free space so the template image compresses well
sudo dd if=/dev/zero of=/zero bs=4M status=progress; sudo rm /zero
sudo fstrim -av    # if your filesystem supports it (ext4 with discard, etc.)

# Shutdown — DO NOT reboot
sudo poweroff
